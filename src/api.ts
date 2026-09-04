/**
 * The ONE HTTP layer of the thin client.
 *
 * Every tool handler goes through here, and nothing else in `src/` may hold a
 * base URL or invent an error message. Two rules are load-bearing:
 *
 * 1. **Relay, never compose.** Response bodies are returned untouched — the
 *    records and signup URLs in them are authored server-side by the fixengine
 *    and are the product's trust moat. This file never edits a payload.
 * 2. **A transport failure is never a verdict.** 429/5xx/network faults map to
 *    explicitly transient errors that tell the agent to retry rather than
 *    report a diagnosis, mirroring the backend's `temperror` discipline.
 *
 * A 422 relays the API's `detail` **verbatim** — those strings are a wire
 * contract shared with the hosted MCP server; rewording them here would let the
 * two surfaces disagree about the same malformed input.
 */

import { readFileSync } from "node:fs";

export const DEFAULT_API_BASE = "https://dnsdoctor.dev";

/** Shared tail of every transient message — one string, so all of them agree. */
export const TRANSIENT_SUFFIX = "retry; never report this as a verdict";

export const RATE_LIMITED_MESSAGE = "rate limited — slow down and retry";

/**
 * A 402 is the same exhausted per-CALLER budget as a 429, offered as a paid
 * burst lane (D104) this client deliberately does not pay: it holds no wallet
 * and never will. So it reads as the rate limit it is — transient, retry — and
 * the offer is named rather than surfaced as an opaque HTTP code.
 */
export const PAYMENT_REQUIRED_MESSAGE =
  "rate limited — a paid burst lane was offered; this client does not pay, so slow down and retry";

/** Error raised for any non-2xx response or transport fault. */
export class ApiError extends Error {
  readonly status: number | null;
  readonly transient: boolean;

  constructor(message: string, status: number | null, transient: boolean) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.transient = transient;
  }
}

/** Base URL for the DNS Doctor API; `DNSDOCTOR_API_BASE` overrides for local runs. */
export function apiBase(): string {
  const raw = process.env.DNSDOCTOR_API_BASE?.trim();
  const base = raw ? raw : DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
}

/**
 * The bearer token, when the environment carries one — sent on every request,
 * GET included.
 *
 * Most tools work anonymously and a token only raises the budget, but the two
 * monitoring reads (`get_alerts`, `get_readiness`) REQUIRE one: without it the
 * API answers 401 and its `detail` is the guidance (mint one on the dashboard),
 * which `toApiError` relays verbatim. Never prompt a human for the token here.
 */
function authHeaders(): Record<string, string> {
  const token = process.env.DNSDOCTOR_API_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** This package's version — also what the server reports in `initialize`. */
export function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The UA every call carries — this client's only attribution.
 *
 * `api/agents.py::agent_family` is an ALLOWLIST: an unrecognized UA is not
 * counted at all, so without this marker the npm channel would be invisible in
 * `dnsdoctor_agent_requests_total`, which is the number the agent channel's
 * kill criterion reads. The matching entry lives in that module's `_FAMILIES`.
 */
export function userAgent(): string {
  return `dnsdoctor-mcp/${packageVersion()} (+https://dnsdoctor.dev)`;
}

/** Pull the API's `detail` out of an error body, preserving its exact text. */
function detailOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (detail === undefined || detail === null) return null;
  return JSON.stringify(detail);
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const detail = detailOf(await readBody(response));
  const status = response.status;
  if (status === 429) {
    // The constant leads, so the agent always reads the same instruction; the
    // API's own detail (which domain, which budget) rides along verbatim.
    const message = detail ? `${RATE_LIMITED_MESSAGE} (${detail})` : RATE_LIMITED_MESSAGE;
    return new ApiError(message, status, true);
  }
  if (status === 402) {
    // The x402 offer rides in the `PAYMENT-REQUIRED` header and the body carries
    // no `detail`, so there is nothing to relay verbatim here — only the reason.
    return new ApiError(PAYMENT_REQUIRED_MESSAGE, status, true);
  }
  if (status === 503) {
    return new ApiError(
      `DNS Doctor could not complete the lookup (transient) — ${TRANSIENT_SUFFIX}`,
      status,
      true,
    );
  }
  if (status >= 500) {
    return new ApiError(
      `DNS Doctor returned a server error (HTTP ${status}) — ${TRANSIENT_SUFFIX}`,
      status,
      true,
    );
  }
  // 4xx — the API's own `detail` is the answer (422 malformed input, opaque 404,
  // 413 oversize report). Verbatim, always.
  return new ApiError(detail ?? `DNS Doctor request failed (HTTP ${status})`, status, false);
}

async function send(path: string, init: RequestInit): Promise<unknown> {
  const url = `${apiBase()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent(),
        ...authHeaders(),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new ApiError(
      `Could not reach the DNS Doctor API (${cause}) — ${TRANSIENT_SUFFIX}`,
      null,
      true,
    );
  }
  if (!response.ok) throw await toApiError(response);
  const body = await readBody(response);
  if (body === null) {
    throw new ApiError(
      `DNS Doctor returned an unreadable response (HTTP ${response.status}) — ${TRANSIENT_SUFFIX}`,
      response.status,
      true,
    );
  }
  return body;
}

/** GET a JSON resource. `path` is API-root-relative and already encoded. */
export function getJson(path: string): Promise<unknown> {
  return send(path, { method: "GET" });
}

/** POST a JSON body and return the parsed response, untouched. */
export function postJson(path: string, body: unknown): Promise<unknown> {
  return send(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Decode base64, rejecting input Node would silently mangle.
 *
 * Not transient: the caller sent bad bytes, so retrying the same call changes
 * nothing — the agent must re-encode instead of reporting a verdict.
 */
export function decodeBase64(value: string): Buffer {
  // Whitespace (MIME line breaks) and the base64url alphabet are both accepted
  // — Node decodes them and so should we; the round-trip below is what rejects
  // input that is not base64 at all.
  const compact = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw new ApiError(
      "'content_base64' is not valid base64 — re-encode the report file and try again",
      null,
      false,
    );
  }
  return bytes;
}

/**
 * POST one file as `multipart/form-data` — the shape `/api/tools/dmarc-report-parse`
 * expects. The tool takes the report as base64, so the bytes are decoded here and
 * uploaded as a file part rather than re-encoded into JSON.
 */
// `async`, so a decode rejection reaches callers the same way a transport one
// does — a synchronous throw from a Promise-returning function is a trap.
export async function postFile(
  path: string,
  field: string,
  filename: string,
  contentBase64: string,
): Promise<unknown> {
  // Validated, not try/caught: `Buffer.from(s, "base64")` never throws — it
  // silently DISCARDS characters outside the alphabet. Uploading those bytes
  // would earn a 422 "not a DMARC report file", telling the agent its report is
  // invalid when the real fault is the encoding it sent us.
  const bytes = decodeBase64(contentBase64);
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: "application/octet-stream" }), filename);
  // No Content-Type header: fetch sets it with the multipart boundary.
  return send(path, { method: "POST", body: form });
}
