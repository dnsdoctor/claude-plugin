import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir as tmpdir_base } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { callTool, createServer, isEntrypoint, unroutedTools } from "../src/index.js";
import { listTools } from "../src/tools.js";

const FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("../tools.json", import.meta.url), "utf8"),
);
const INSTRUCTIONS = readFileSync(new URL("../instructions.txt", import.meta.url), "utf8");
const PACKAGE = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

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

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("tools/list", () => {
  it("is exactly the fixture — nothing added, nothing reshaped", async () => {
    const client = await connectedClient();
    const result = await client.listTools();
    expect(result.tools).toEqual(FIXTURE);
    await client.close();
  });

  it("exposes the fifteen hosted tools", () => {
    expect(listTools()).toHaveLength(16);
  });

  it("routes every fixture tool", () => {
    expect(unroutedTools()).toEqual([]);
  });
});

describe("initialize", () => {
  it("advertises this package's name and version", async () => {
    const client = await connectedClient();
    expect(client.getServerVersion()).toEqual({
      name: "dns-doctor",
      version: PACKAGE.version,
    });
    await client.close();
  });

  it("ships the hosted server's safety preamble as MCP instructions", async () => {
    // A host other than Claude Code reads these rules nowhere else — the
    // bundled SKILL.md is Claude-Code-only.
    const client = await connectedClient();
    const text = client.getInstructions();
    expect(text).toBe(INSTRUCTIONS.trim());
    expect(text).toContain("PRESENT ANY RETURNED RECORD VERBATIM");
    expect(text).toContain("SPF is diagnose-only");
    await client.close();
  });
});

describe("handlers", () => {
  it("scan_domain posts to /api/v1/scan and relays the body untouched", async () => {
    const report = {
      domain: "example.com",
      checks: [{ name: "dmarc", status: "fail", fix_record: "v=DMARC1; p=quarantine; np=reject" }],
      next_steps: { summary: "…" },
    };
    fetchMock.mockResolvedValue(jsonResponse(200, report));
    const body = await callTool("scan_domain", { domain: "example.com" });
    const [url, init] = lastCall();
    expect(url).toBe("https://dnsdoctor.dev/api/v1/scan");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ domain: "example.com" });
    expect(body).toEqual(report);
  });

  it("get_report reads the domain from the path, encoded", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { domain: "exämple.com" }));
    await callTool("get_report", { domain: "exämple.com" });
    expect(lastCall()[0]).toBe("https://dnsdoctor.dev/api/v1/report/ex%C3%A4mple.com");
    expect(lastCall()[1].method).toBe("GET");
  });

  it("build_dmarc_upgrade relays a null record and its rationale untouched", async () => {
    const answer = {
      domain: "example.com",
      record: null,
      policy: null,
      current_policy: "reject",
      alignment_ok: true,
      rationale: "example.com already applies a policy at least as strong as this scan justifies.",
      apply_note: null,
    };
    fetchMock.mockResolvedValue(jsonResponse(200, answer));
    const body = await callTool("build_dmarc_upgrade", { domain: "example.com" });
    expect(lastCall()[0]).toBe("https://dnsdoctor.dev/api/v1/dmarc-upgrade");
    expect(body).toEqual(answer);
  });

  it("start_monitoring_signup relays the server-built URLs verbatim", async () => {
    const answer = {
      signup_url: "https://dnsdoctor.dev/start?domain=example.com&ref=agent",
      report_url: "https://dnsdoctor.dev/scan/example.com",
      message: "Open the link and sign in.",
    };
    fetchMock.mockResolvedValue(jsonResponse(200, answer));
    const body = await callTool("start_monitoring_signup", { domain: "example.com" });
    expect(lastCall()[0]).toBe("https://dnsdoctor.dev/api/v1/signup-url");
    expect(body).toEqual(answer);
  });

  it("passes tool arguments through as the REST body, unchanged", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { record: "v=DMARC1; p=none" }));
    await callTool("generate_dmarc_record", {
      policy: "none",
      rua_email: "dmarc@example.com",
      strict_alignment: true,
    });
    const [url, init] = lastCall();
    expect(url).toBe("https://dnsdoctor.dev/api/tools/dmarc-generate");
    expect(JSON.parse(init.body as string)).toEqual({
      policy: "none",
      rua_email: "dmarc@example.com",
      strict_alignment: true,
    });
  });

  it("maps the remaining tools onto their endpoints", async () => {
    const expected: Record<string, string> = {
      count_spf_lookups: "/api/tools/spf-count",
      validate_dmarc_record: "/api/tools/dmarc-validate",
      check_dkim_selector: "/api/tools/dkim-check",
      check_record: "/api/tools/check-record",
      check_reverse_dns: "/api/tools/reverse-dns-check",
    };
    for (const [tool, path] of Object.entries(expected)) {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      await callTool(tool, { domain: "example.com" });
      expect(lastCall()[0]).toBe(`https://dnsdoctor.dev${path}`);
    }
  });

  it("get_alerts is a GET whose search params are its own arguments", async () => {
    const page = {
      next_before: "2026-08-04T10:00:00+00:00,41",
      alerts: [{ id: 42, domain: "example.com", delivery_class: "dashboard_only" }],
    };
    fetchMock.mockResolvedValue(jsonResponse(200, page));
    const body = await callTool("get_alerts", {
      since: "2026-08-01T00:00:00+00:00",
      domain: "example.com",
      type: "record_changed",
      limit: 10,
      before: "2026-08-04T11:00:00+00:00,99",
    });
    const [url, init] = lastCall();
    expect(init.method).toBe("GET");
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://dnsdoctor.dev/api/v1/alerts");
    // Names and values, not their ORDER: the server reads query params as a
    // map, so pinning the order would fail a correct client that sorted keys
    // for deterministic URLs. The subject here is that each argument is relayed
    // under its own name, verbatim — the cursor especially (asserted again
    // below), since a re-encoded one strands rows.
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      since: "2026-08-01T00:00:00+00:00",
      domain: "example.com",
      type: "record_changed",
      limit: "10",
      before: "2026-08-04T11:00:00+00:00,99",
    });
    // The cursor is relayed byte-for-byte — a client that reshaped it would page
    // into the wrong window, silently.
    expect(body).toEqual(page);
  });

  it("omits absent get_alerts filters rather than sending blanks or defaults", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { next_before: null, alerts: [] }));
    await callTool("get_alerts", { domain: "example.com", since: undefined, before: null });
    // No invented `limit`: the server owns the page size, and a default composed
    // here would disagree with it the day it changes.
    expect(lastCall()[0]).toBe("https://dnsdoctor.dev/api/v1/alerts?domain=example.com");
  });

  it("get_readiness sends its required domain as a search param", async () => {
    const verdict = { domain: "exämple.com", ready: false, next_record: null };
    fetchMock.mockResolvedValue(jsonResponse(200, verdict));
    const body = await callTool("get_readiness", { domain: "exämple.com" });
    const [url, init] = lastCall();
    expect(init.method).toBe("GET");
    expect(url).toBe("https://dnsdoctor.dev/api/v1/readiness?domain=ex%C3%A4mple.com");
    expect(body).toEqual(verdict);
  });

  it("sends the bearer token on a query-kind GET and relays a 401 detail verbatim", async () => {
    process.env.DNSDOCTOR_API_TOKEN = "dnsd_YOUR_TOKEN";
    fetchMock.mockResolvedValue(jsonResponse(200, { next_before: null, alerts: [] }));
    await callTool("get_alerts", {});
    expect(headersOf(lastCall()[1])["Authorization"]).toBe("Bearer dnsd_YOUR_TOKEN");

    delete process.env.DNSDOCTOR_API_TOKEN;
    const guidance =
      "an API token is required — mint one at https://dnsdoctor.dev/dashboard/settings";
    fetchMock.mockResolvedValue(jsonResponse(401, { detail: guidance }));
    await expect(callTool("get_alerts", {})).rejects.toThrow(guidance);
    expect(headersOf(lastCall()[1])["Authorization"]).toBeUndefined();
  });

  it("parse_dmarc_report decodes base64 into a multipart file part", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { rows: [] }));
    const xml = "<feedback/>";
    await callTool("parse_dmarc_report", {
      content_base64: Buffer.from(xml, "utf8").toString("base64"),
      filename: "aggregate.xml",
    });
    const [url, init] = lastCall();
    expect(url).toBe("https://dnsdoctor.dev/api/tools/dmarc-report-parse");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("aggregate.xml");
    expect(await file.text()).toBe(xml);
    // fetch owns the multipart boundary — a hand-set Content-Type would break it.
    expect(headersOf(init)["Content-Type"]).toBeUndefined();
  });

  it("names the upload when the caller omits a filename", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { rows: [] }));
    await callTool("parse_dmarc_report", { content_base64: "PGZlZWRiYWNrLz4=" });
    const file = (lastCall()[1].body as FormData).get("file") as File;
    expect(file.name).toBe("report.xml");
  });

  it("rejects an unknown tool without touching the network", async () => {
    await expect(callTool("delete_everything", {})).rejects.toThrow(
      "unknown tool 'delete_everything'",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing required argument without touching the network", async () => {
    await expect(callTool("get_report", {})).rejects.toThrow("'domain' is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tools/call over the protocol", () => {
  it("returns the API body as text content", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { domain: "example.com", grade: "B" }));
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_report", arguments: { domain: "example.com" } });
    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toEqual({ domain: "example.com", grade: "B" });
    await client.close();
  });

  it("relays an API 422 detail verbatim as a tool error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { detail: "domain is not a valid hostname" }));
    const client = await connectedClient();
    const result = await client.callTool({ name: "scan_domain", arguments: { domain: "!!" } });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]!.text).toBe("domain is not a valid hostname");
    await client.close();
  });
});

describe("entrypoint detection", () => {
  const argv1 = process.argv[1];
  const self = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = mkdtempSync(join(tmpdir_base(), "dd-entry-"));
  });

  afterEach(() => {
    process.argv[1] = argv1 as string;
    rmSync(tmpdir, { recursive: true, force: true });
  });

  it("is true when launched through a bin symlink, as npm installs it", () => {
    // The regression the `npm pack` smoke caught: npm links `bin` entries into
    // node_modules/.bin, so argv[1] is the symlink while import.meta.url is
    // already its target. A raw string compare is false for every installed user.
    const link = join(tmpdir, "dnsdoctor-mcp");
    symlinkSync(self, link);
    process.argv[1] = link;
    expect(isEntrypoint()).toBe(true);
  });

  it("is true when the real path is invoked directly", () => {
    process.argv[1] = self;
    expect(isEntrypoint()).toBe(true);
  });

  it("is false when some other script is the entrypoint (an importing test)", () => {
    process.argv[1] = join(tmpdir, "vitest.js");
    expect(isEntrypoint()).toBe(false);
  });
});

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}
