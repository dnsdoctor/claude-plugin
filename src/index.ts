#!/usr/bin/env node
/**
 * `@dnsdoctor/mcp` — a thin stdio MCP server in front of the public DNS Doctor
 * REST API.
 *
 * It holds no diagnosis logic of its own. Every tool is one HTTP call whose
 * response is relayed **verbatim**: the record strings, signup URLs and verdicts
 * in those payloads are authored server-side by the fixengine, and rewriting one
 * here would break the product's central invariant (an LLM — or a client — never
 * composes an authoritative record). The tool definitions come from `tools.json`
 * (see `tools.ts`), so the only thing this file decides is which endpoint each
 * tool calls.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ApiError, getJson, packageVersion, postFile, postJson } from "./api.js";
import { instructions, listTools, toolNames } from "./tools.js";

type ToolArgs = Record<string, unknown>;

/**
 * How each tool reaches the API.
 *
 * `json` posts the caller's arguments as the request body **unchanged** — the
 * tool argument names are the REST field names on every one of these endpoints,
 * so there is nothing to translate and therefore nothing to get wrong. The two
 * exceptions carry their own kind: `get_report` puts the domain in the path, and
 * `parse_dmarc_report` takes the report as base64 and must upload it as a file
 * part.
 */
type Route =
  | { kind: "json"; path: string }
  | { kind: "report" }
  | { kind: "upload"; path: string; field: string };

const ROUTES: Record<string, Route> = {
  scan_domain: { kind: "json", path: "/api/v1/scan" },
  get_report: { kind: "report" },
  build_dmarc_upgrade: { kind: "json", path: "/api/v1/dmarc-upgrade" },
  start_monitoring_signup: { kind: "json", path: "/api/v1/signup-url" },
  count_spf_lookups: { kind: "json", path: "/api/tools/spf-count" },
  validate_dmarc_record: { kind: "json", path: "/api/tools/dmarc-validate" },
  generate_dmarc_record: { kind: "json", path: "/api/tools/dmarc-generate" },
  check_dkim_selector: { kind: "json", path: "/api/tools/dkim-check" },
  parse_dmarc_report: {
    kind: "upload",
    path: "/api/tools/dmarc-report-parse",
    field: "file",
  },
  check_record: { kind: "json", path: "/api/tools/check-record" },
  check_reverse_dns: { kind: "json", path: "/api/tools/reverse-dns-check" },
};

/** Default upload name when the caller supplies none — the API only reads bytes. */
const DEFAULT_REPORT_FILENAME = "report.xml";

function requireString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(`'${key}' is required and must be a non-empty string`, null, false);
  }
  return value;
}

/** Run one tool and return the API's parsed body, untouched. */
export async function callTool(name: string, args: ToolArgs = {}): Promise<unknown> {
  const route = ROUTES[name];
  if (route === undefined) {
    throw new ApiError(`unknown tool '${name}'`, null, false);
  }
  if (route.kind === "report") {
    const domain = requireString(args, "domain");
    return getJson(`/api/v1/report/${encodeURIComponent(domain)}`);
  }
  if (route.kind === "upload") {
    const content = requireString(args, "content_base64");
    const filename = args["filename"];
    return postFile(
      route.path,
      route.field,
      typeof filename === "string" && filename.trim() !== "" ? filename : DEFAULT_REPORT_FILENAME,
      content,
    );
  }
  return postJson(route.path, args);
}

function okResult(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Build the MCP server with the fixture's tools and instructions registered. */
export function createServer(): Server {
  const server = new Server(
    { name: "dns-doctor", version: packageVersion() },
    // `instructions` is the hosted server's own preamble, shipped in the pinned
    // fixture: without it a host other than Claude Code (which reads the bundled
    // SKILL.md) gets the tools with none of the safety contract around them.
    { capabilities: { tools: {} }, instructions: instructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return okResult(await callTool(name, args ?? {}));
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}

/** Every fixture tool has a route — a missing one would 'unknown tool' at runtime. */
export function unroutedTools(): string[] {
  return toolNames().filter((name) => ROUTES[name] === undefined);
}

export async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

/**
 * True when this module is the process entrypoint — false when a test imports it.
 *
 * Both sides are resolved through `realpathSync` because npm installs `bin`
 * entries as **symlinks**: launched as `dnsdoctor-mcp` (or via `npx`),
 * `process.argv[1]` is `node_modules/.bin/dnsdoctor-mcp` while
 * `import.meta.url` is already the symlink's target, so a raw string compare is
 * false for every installed user and the server silently never starts. That is
 * invisible to `node dist/index.js` and shows up only in the `npm pack` smoke.
 */
export function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const resolve = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
