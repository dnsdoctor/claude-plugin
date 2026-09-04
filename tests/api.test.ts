import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  DEFAULT_API_BASE,
  PAYMENT_REQUIRED_MESSAGE,
  RATE_LIMITED_MESSAGE,
  TRANSIENT_SUFFIX,
  apiBase,
  getJson,
  packageVersion,
  postFile,
  postJson,
  userAgent,
} from "../src/api.js";

/** Minimal `Response` stand-in — enough for the layer's `ok`/`status`/`json()` reads. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.DNSDOCTOR_API_BASE;
  delete process.env.DNSDOCTOR_API_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DNSDOCTOR_API_BASE;
  delete process.env.DNSDOCTOR_API_TOKEN;
});

function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call as [string, RequestInit];
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe("base URL", () => {
  it("defaults to the hosted origin", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await getJson("/api/v1/report/example.com");
    expect(apiBase()).toBe(DEFAULT_API_BASE);
    expect(lastCall()[0]).toBe(`${DEFAULT_API_BASE}/api/v1/report/example.com`);
  });

  it("honors DNSDOCTOR_API_BASE and strips a trailing slash", async () => {
    process.env.DNSDOCTOR_API_BASE = "http://127.0.0.1:8000/";
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await postJson("/api/v1/scan", { domain: "example.com" });
    expect(lastCall()[0]).toBe("http://127.0.0.1:8000/api/v1/scan");
  });
});

describe("auth header", () => {
  it("is absent when no token is configured", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await getJson("/api/v1/report/example.com");
    expect(headersOf(lastCall()[1]).Authorization).toBeUndefined();
  });

  it("attaches the bearer token when DNSDOCTOR_API_TOKEN is set", async () => {
    process.env.DNSDOCTOR_API_TOKEN = "dnsd_live_token";
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await getJson("/api/v1/report/example.com");
    expect(headersOf(lastCall()[1]).Authorization).toBe("Bearer dnsd_live_token");
  });
});

describe("user agent", () => {
  it("identifies this client so the agent channel can meter it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await getJson("/api/v1/report/example.com");
    // `api/agents.py::agent_family` is an allowlist keyed on this substring —
    // an unrecognized UA is not counted at all.
    expect(headersOf(lastCall()[1])["User-Agent"]).toContain("dnsdoctor-mcp/");
    expect(userAgent()).toContain(packageVersion());
  });
});

describe("relay", () => {
  it("returns the parsed body untouched", async () => {
    const body = {
      domain: "example.com",
      record: "v=DMARC1; p=quarantine; np=reject; rua=mailto:x@example.com",
      policy: "quarantine",
      nested: { keep: [1, 2, 3] },
    };
    fetchMock.mockResolvedValue(jsonResponse(200, body));
    await expect(postJson("/api/v1/dmarc-upgrade", { domain: "example.com" })).resolves.toEqual(
      body,
    );
  });

  it("sends the JSON body it was given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await postJson("/api/v1/scan", { domain: "Example.COM" });
    const init = lastCall()[1];
    expect(init.method).toBe("POST");
    expect(headersOf(init)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ domain: "Example.COM" }));
  });
});

describe("error mapping", () => {
  it("relays a 422 detail byte-identically", async () => {
    const detail = "domain must be a valid hostname (got 'not a domain')";
    fetchMock.mockResolvedValue(jsonResponse(422, { detail }));
    const error = await postJson("/api/v1/signup-url", { domain: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(detail);
    expect(error.status).toBe(422);
    expect(error.transient).toBe(false);
  });

  it("serializes a non-string 422 detail rather than dropping it", async () => {
    const detail = [{ loc: ["body", "domain"], msg: "field required" }];
    fetchMock.mockResolvedValue(jsonResponse(422, { detail }));
    const error = await postJson("/api/v1/scan", {}).catch((e) => e);
    expect(error.message).toBe(JSON.stringify(detail));
  });

  it("relays a 404 detail verbatim (the opaque suppressed/no-report answer)", async () => {
    const detail = "no persisted report for this domain";
    fetchMock.mockResolvedValue(jsonResponse(404, { detail }));
    const error = await getJson("/api/v1/report/example.com").catch((e) => e);
    expect(error.message).toBe(detail);
    expect(error.transient).toBe(false);
  });

  it("maps 429 to the rate-limit instruction, carrying the API detail", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { detail: "this domain is being scanned too frequently" }),
    );
    const error = await postJson("/api/v1/scan", { domain: "example.com" }).catch((e) => e);
    expect(error.message).toBe(
      `${RATE_LIMITED_MESSAGE} (this domain is being scanned too frequently)`,
    );
    expect(error.status).toBe(429);
    expect(error.transient).toBe(true);
  });

  it("maps 503 to a transient error that forbids reporting a verdict", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { detail: "temporary DNS failure" }));
    const error = await postJson("/api/v1/dmarc-upgrade", { domain: "example.com" }).catch((e) => e);
    expect(error.transient).toBe(true);
    expect(error.message).toContain(TRANSIENT_SUFFIX);
  });

  it("maps any other 5xx to a transient error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    const error = await getJson("/api/v1/report/example.com").catch((e) => e);
    expect(error.transient).toBe(true);
    expect(error.status).toBe(500);
    expect(error.message).toContain(TRANSIENT_SUFFIX);
  });

  it("maps a bare 429 to the instruction alone, with no empty parenthetical", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, {}));
    const error = await postJson("/api/v1/scan", { domain: "example.com" }).catch((e) => e);
    expect(error.message).toBe(RATE_LIMITED_MESSAGE);
    expect(error.transient).toBe(true);
  });

  it("maps the x402 402 to the rate limit it is, transient and named", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 402 }));
    const error = await postJson("/api/v1/scan", { domain: "example.com" }).catch((e) => e);
    expect(error.message).toBe(PAYMENT_REQUIRED_MESSAGE);
    expect(error.status).toBe(402);
    expect(error.transient).toBe(true);
  });

  it("falls back to the status when a 4xx carries no readable detail", async () => {
    fetchMock.mockResolvedValue(new Response("<html>nope</html>", { status: 400 }));
    const error = await postJson("/api/v1/scan", { domain: "example.com" }).catch((e) => e);
    expect(error.message).toBe("DNS Doctor request failed (HTTP 400)");
    expect(error.transient).toBe(false);
  });

  it("maps a network failure to a transient error and never fabricates a result", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const error = await getJson("/api/v1/report/example.com").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.transient).toBe(true);
    expect(error.status).toBeNull();
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.message).toContain(TRANSIENT_SUFFIX);
  });

  it("treats an unreadable 200 body as transient rather than an empty verdict", async () => {
    fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    const error = await getJson("/api/v1/report/example.com").catch((e) => e);
    expect(error.transient).toBe(true);
    expect(error.message).toContain(TRANSIENT_SUFFIX);
  });
});

describe("multipart upload", () => {
  it("decodes base64 into a file part", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { sources: [] }));
    const xml = "<feedback><report_metadata/></feedback>";
    await postFile(
      "/api/tools/dmarc-report-parse",
      "file",
      "report.xml",
      Buffer.from(xml).toString("base64"),
    );
    const init = lastCall()[1];
    expect(init.method).toBe("POST");
    expect(headersOf(init)["Content-Type"]).toBeUndefined();
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const part = form.get("file") as File;
    expect(part.name).toBe("report.xml");
    await expect(part.text()).resolves.toBe(xml);
  });

  it("rejects malformed base64 before the wire, naming the encoding as the fault", async () => {
    const error = await postFile(
      "/api/tools/dmarc-report-parse",
      "file",
      "r.xml",
      "!!! not base64 !!!",
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("not valid base64");
    expect(error.transient).toBe(false);
    // Node would have silently dropped the bad characters and uploaded garbage,
    // earning a 422 that reads as "your report is invalid".
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts whitespace-wrapped and base64url-encoded payloads", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const bytes = Buffer.from([0xfb, 0xff, 0xbf]);
    const urlSafe = bytes.toString("base64url");
    await postFile("/api/tools/dmarc-report-parse", "file", "r.xml", `${urlSafe}\n`);
    const part = (lastCall()[1].body as FormData).get("file") as File;
    expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes);
  });

  it("carries the bearer token on uploads too", async () => {
    process.env.DNSDOCTOR_API_TOKEN = "dnsd_upload";
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await postFile("/api/tools/dmarc-report-parse", "file", "r.xml", "eA==");
    expect(headersOf(lastCall()[1]).Authorization).toBe("Bearer dnsd_upload");
  });
});
