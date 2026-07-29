/**
 * Structural guards — the client's half of the project-wide invariant that an
 * authoritative record string is only ever *relayed*, never composed.
 *
 * The client holds no fixengine, so the failure mode here is a well-meaning
 * literal: a "helpful" default record, an example DMARC policy in a message, a
 * second hard-coded origin that quietly sends traffic somewhere else. Both
 * checks read the real `src/` files rather than trusting review.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC_DIR = new URL("../src/", import.meta.url);

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(new URL(name, SRC_DIR), "utf8") }));
}

/** Record-shaped literals: if one of these appears, something is being composed. */
const RECORD_PATTERNS: RegExp[] = [
  /v=spf1/i,
  /v=DMARC1/i,
  /\bp=(none|quarantine|reject)\b/i,
  /\brua=/i,
];

describe("no record composition in src/", () => {
  const files = sourceFiles();

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const pattern of RECORD_PATTERNS) {
    it(`contains no ${pattern.source} literal`, () => {
      const offenders = files.filter((file) => pattern.test(file.text)).map((file) => file.name);
      expect(offenders).toEqual([]);
    });
  }
});

describe("one home for the origin", () => {
  it("mentions the hosted origin only in api.ts", () => {
    const offenders = sourceFiles()
      .filter((file) => file.name !== "api.ts" && file.text.includes("https://dnsdoctor.dev"))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});

describe("the tarball carries everything the client reads at runtime", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { files: string[]; bin: Record<string, string>; scripts: Record<string, string> };

  it("publishes both fixtures — without them the client has no tools and no rules", () => {
    // `src/tools.ts` throws on a missing tools.json and the instructions are the
    // safety contract; a `files` edit that drops one breaks every install while
    // every unit test stays green.
    expect(pkg.files).toContain("tools.json");
    expect(pkg.files).toContain("instructions.txt");
    expect(pkg.files).toContain("dist");
  });

  it("builds on pack, so the bin target cannot be missing from the tarball", () => {
    // `dist/` is gitignored AND excluded from the public snapshot sync, so a
    // publish from a fresh checkout without this hook ships a bin that is not there.
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.bin["dnsdoctor-mcp"]).toBe("dist/index.js");
  });
});

describe("no tool copy in src/", () => {
  it("names no tool description or schema — the fixture is the only source", () => {
    const fixture: { name: string; description: string }[] = JSON.parse(
      readFileSync(new URL("../tools.json", import.meta.url), "utf8"),
    );
    const sources = sourceFiles()
      .filter((file) => file.name !== "tools.ts")
      .map((file) => file.text)
      .join("\n");
    const leaked = fixture.filter((tool) => sources.includes(tool.description.slice(0, 40)));
    expect(leaked.map((tool) => tool.name)).toEqual([]);
  });
});
