/**
 * The tool definitions and the `initialize` preamble — read from the fixtures,
 * never authored here.
 *
 * `tools.json` and `instructions.txt` are generated from the hosted server's own
 * `list_tools()` and instructions, and pinned byte-for-byte by
 * `backend/tests/mcp_server/test_tools_fixture.py`. That is the whole point: a
 * name, description, schema or instruction sentence edited on the server fails a
 * backend test until the fixtures are regenerated, so this client cannot drift
 * from the surface it claims to mirror. Consequently **no description string,
 * schema, tool name or guidance sentence is written in `src/`** — everything
 * comes from the files.
 */

import { readFileSync } from "node:fs";

/** One entry of `tools.json`; the shape the MCP `tools/list` result expects. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * `tools.json` sits at the package root — one level up from both `src/` (tests,
 * run from source) and `dist/` (the published `bin`), so the same relative URL
 * resolves in either. It ships in `package.json#files`; without it the client
 * has no tools at all, which is why a missing file throws rather than degrading
 * to an empty list.
 */
const FIXTURE_URL = new URL("../tools.json", import.meta.url);

function readFixture(): ToolDefinition[] {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE_URL, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("tools.json is not a non-empty array of tool definitions");
  }
  return parsed as ToolDefinition[];
}

const TOOLS: ToolDefinition[] = readFixture();

/** Every tool the hosted server exposes, in the fixture's own (sorted) order. */
export function listTools(): ToolDefinition[] {
  return TOOLS;
}

/** The tool names, for the dispatch table's coverage check. */
export function toolNames(): string[] {
  return TOOLS.map((tool) => tool.name);
}

/**
 * The in-band guidance the hosted server sends in `initialize`, shipped verbatim.
 *
 * Claude Code users read the same rules from the bundled SKILL.md; every OTHER
 * host running `npx -y @dnsdoctor/mcp` reads them only here. Dropping them would
 * leave an agent with no `temperror`-is-not-a-failure rule, no
 * `not_registered`-is-not-health rule, no records-verbatim rule and no
 * SPF-is-diagnose-only rule — the product's safety contract, not decoration.
 */
const INSTRUCTIONS: string = readFileSync(
  new URL("../instructions.txt", import.meta.url),
  "utf8",
).trim();

export function instructions(): string {
  return INSTRUCTIONS;
}
