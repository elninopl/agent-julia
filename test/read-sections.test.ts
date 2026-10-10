import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { READ_WHOLE_MAX, registerTools } from "../src/tools/register.js";
import { demoteHeadings, extractSection, sections, tableOfContents } from "../src/store/sections.js";
import { adoptCodeMemory, nestAbsorbedFacts } from "../src/surfaces/code-memory.js";
import { Indexer } from "../src/index/indexer.js";
import { storePaths } from "../src/store/paths.js";
import { readPage, writePage } from "../src/store/markdown.js";
import { ConfigSchema } from "../src/config/schema.js";

function textOf(result: unknown): string {
  return ((result as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
}

describe("sections of a page", () => {
  const body = [
    "Intro line.",
    "## First",
    "one",
    "### Detail",
    "deeper",
    "```",
    "## not a heading, inside a fence",
    "```",
    "## Second fact",
    "two",
  ].join("\n");

  it("runs a section to the next heading at its level, ignoring fenced code", () => {
    expect(sections(body).map((s) => s.heading)).toEqual(["First", "Detail", "Second fact"]);
    expect(extractSection(body, "First")!.text).toContain("deeper");
    expect(extractSection(body, "First")!.text).toContain("## not a heading");
    expect(extractSection(body, "First")!.text).not.toContain("two");
  });

  it("matches a heading regardless of case, spacing and punctuation", () => {
    expect(extractSection(body, "second  FACT")!.heading).toBe("Second fact");
    expect(extractSection(body, "second-fact")!.heading).toBe("Second fact");
    expect(extractSection(body, "third")).toBeNull();
  });

  it("lists only the top level in the table of contents", () => {
    expect(tableOfContents(body).map((t) => t.heading)).toEqual(["First", "Second fact"]);
  });

  it("demotes headings so the shallowest lands where asked, fences untouched", () => {
    const out = demoteHeadings("# A\n## B\n```\n# kept\n```", 3);
    expect(out).toBe("### A\n#### B\n```\n# kept\n```");
    expect(demoteHeadings("### already", 3)).toBe("### already");
  });
});

describe("read on a long page", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  async function connect() {
    const dir = mkdtempSync(join(tmpdir(), "aj-read-"));
    const config = ConfigSchema.parse({ memoryDir: dir, git: false, search: "fts" });
    const paths = storePaths(dir);
    const indexer = Indexer.open(paths, config);
    const server = new McpServer({ name: "agent-julia", version: "test" });
    registerTools(server, { config, paths, indexer });
    const client = new Client({ name: "test", version: "test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    cleanup = async () => {
      await client.close();
      indexer.close();
    };
    return { client, paths };
  }

  const longBody = Array.from(
    { length: 60 },
    (_, i) => `## fact-${i}\n\n${`Fact number ${i}, written at length. `.repeat(20)}`,
  ).join("\n\n");

  it("answers with the table of contents, one section on request, and everything with full", async () => {
    const { client, paths } = await connect();
    await writePage(paths, "notes", longBody, {});
    const raw = readFileSync(join(paths.pagesDir, "notes.md"), "utf8");
    expect(raw.length).toBeGreaterThan(READ_WHOLE_MAX);

    const toc = textOf(await client.callTool({ name: "read", arguments: { page: "notes" } }));
    expect(toc.length).toBeLessThan(5_000);
    expect(toc).toContain("too long to return whole");
    expect(toc).toContain("- fact-59 (");
    expect(toc).toMatch(/^---\n/);

    const one = textOf(await client.callTool({ name: "read", arguments: { page: "notes", section: "fact-7" } }));
    expect(one).toContain("Fact number 7");
    expect(one).not.toContain("Fact number 8");

    const all = textOf(await client.callTool({ name: "read", arguments: { page: "notes", full: true } }));
    expect(all).toBe(raw);

    const miss = textOf(await client.callTool({ name: "read", arguments: { page: "notes", section: "nope" } }));
    expect(miss).toContain('No section "nope"');
    expect(miss).toContain("- fact-0");
  });

  it("returns a short page exactly as stored", async () => {
    const { client, paths } = await connect();
    await writePage(paths, "short", "## Only\n\nA line.", {});
    const raw = readFileSync(join(paths.pagesDir, "short.md"), "utf8");
    expect(textOf(await client.callTool({ name: "read", arguments: { page: "short" } }))).toBe(raw);
  });
});

describe("absorbed facts keep their own headings inside their section", () => {
  const legacy = [
    "## decision-log",
    "",
    "_Captured by Claude Code in /x/atlas · decision-log.md · 1234abcd_",
    "",
    "## Decision",
    "Ship it.",
    "## Risks",
    "None.",
    "",
    "## deploy-notes",
    "",
    "_Captured by Claude Code in /x/atlas · deploy-notes.md · 5678ef90_",
    "",
    "Staging first.",
  ].join("\n");

  it("repairs a page absorbed before, and leaves a repaired one alone", () => {
    const fixed = nestAbsorbedFacts(legacy);
    expect(extractSection(fixed, "decision-log")!.text).toContain("None.");
    expect(tableOfContents(fixed).map((t) => t.heading)).toEqual(["decision-log", "deploy-notes"]);
    expect(nestAbsorbedFacts(fixed)).toBe(fixed);
  });

  function sandbox() {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "aj-nest-")));
    const workingDir = join(dir, "atlas");
    mkdirSync(workingDir);
    const projects = join(dir, "projects");
    const memory = join(projects, workingDir.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "MEMORY.md"), "# Memory index\n");
    const store = join(dir, "store");
    mkdirSync(store);
    const config = ConfigSchema.parse({ memoryDir: store, git: false, search: "fts", codeMemory: "absorb" });
    return { projects, memory, paths: storePaths(store), config };
  }

  it("absorbs a fact with headings as one section, and points at that section", async () => {
    const { projects, memory, paths, config } = sandbox();
    writeFileSync(
      join(memory, "decision-log.md"),
      "---\nname: decision-log\ndescription: What we decided\n---\n\n## Decision\nShip it.\n\n## Risks\nNone.\n",
    );
    const indexer = Indexer.open(paths, config);
    try {
      await adoptCodeMemory(paths, indexer, config, projects);
      const page = (await readPage(paths, "code-memory-atlas"))!;
      expect(extractSection(page.body, "decision-log")!.text).toContain("None.");
      expect(page.body).toContain("### Decision");
      const pointer = readFileSync(join(memory, "decision-log.md"), "utf8");
      expect(pointer).toContain('section "decision-log"');
      expect(pointer).toContain("description: What we decided");
    } finally {
      indexer.close();
    }
  });

  it("rewrites an old pointer to name the section, and repairs the page it points at", async () => {
    const { projects, memory, paths, config } = sandbox();
    await writePage(paths, "code-memory-atlas", legacy, { title: "Claude Code memory: atlas" });
    const oldPointer = [
      "---",
      "name: decision-log",
      "description: What we decided",
      "---",
      "<!-- agent-julia:absorbed page=code-memory-atlas -->",
      "",
      'This fact now lives in agent-julia, on page `code-memory-atlas` (section "decision-log").',
      "Call agent-julia's `read` with that id, or `search`, for the current version.",
      "Don't edit this file: write through `ingest` so every surface sees the change.",
      "",
    ].join("\n");
    writeFileSync(join(memory, "decision-log.md"), oldPointer);
    const indexer = Indexer.open(paths, config);
    try {
      await adoptCodeMemory(paths, indexer, config, projects);
      const pointer = readFileSync(join(memory, "decision-log.md"), "utf8");
      expect(pointer).toContain('with page "code-memory-atlas" and section "decision-log"');
      expect(pointer).toContain("description: What we decided");
      const page = (await readPage(paths, "code-memory-atlas"))!;
      expect(tableOfContents(page.body).map((t) => t.heading)).toEqual(["decision-log", "deploy-notes"]);
    } finally {
      indexer.close();
    }
  });
});
