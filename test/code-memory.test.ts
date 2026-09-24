import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ABSORB_BATCH_LIMIT,
  adoptCodeMemory,
  codeMemoryStatus,
  decodeWorkingDir,
  releaseCodeMemory,
} from "../src/surfaces/code-memory.js";
import { Indexer } from "../src/index/indexer.js";
import { storePaths } from "../src/store/paths.js";
import { readPage, writePage } from "../src/store/markdown.js";
import { parseFrontmatter } from "../src/store/frontmatter.js";
import { ConfigSchema, CodeMemoryMode } from "../src/config/schema.js";

// Claude Code names a memory directory after the working directory it belongs
// to, with every separator replaced by a dash.
function slugify(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

const MEMORY_FILE = `---
name: deploy-notes
description: How this repo gets deployed
metadata:
  type: project
---

Deploys go out through the staging bucket first.
`;

// The path the client would see as a working directory. tmpdir() is not that on
// every platform: /var is a symlink to /private/var on macOS, and on Windows it
// can carry an 8.3 short name ("RUNNER~1") that no directory listing returns.
function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

function sandbox(mode: CodeMemoryMode) {
  const dir = tempDir("aj-cm-");
  const workingDir = join(dir, "my-repo");
  mkdirSync(workingDir);
  const projects = join(dir, "projects");
  const memory = join(projects, slugify(workingDir), "memory");
  mkdirSync(memory, { recursive: true });

  const store = join(dir, "store");
  mkdirSync(store);
  const config = ConfigSchema.parse({ memoryDir: store, git: false, search: "fts", codeMemory: mode });
  return { dir, projects, memory, paths: storePaths(store), config };
}

describe("Claude Code's own memory is pointed here", () => {
  it("owns a block in its index, keeps what was written around it, and leaves the facts alone", async () => {
    const { projects, memory, paths, config } = sandbox("pointer");
    writeFileSync(join(memory, "MEMORY.md"), "# Memory index\n\n- [Deploy notes](deploy-notes.md) — staging\n", "utf8");
    writeFileSync(join(memory, "deploy-notes.md"), MEMORY_FILE, "utf8");
    const indexer = Indexer.open(paths, config);

    try {
      const report = await adoptCodeMemory(paths, indexer, config, projects);
      expect(report.projects).toBe(1);
      expect(report.pointers).toBe(1);
      // Pointer mode reads nothing and moves nothing: it only says where the
      // memory lives.
      expect(report.absorbed).toBe(0);
      expect(report.pending).toBe(1);

      const index = readFileSync(join(memory, "MEMORY.md"), "utf8");
      expect(index).toContain("# Memory index");
      expect(index).toContain("- [Deploy notes](deploy-notes.md)");
      expect(index).toContain("lives in agent-julia");
      expect(readFileSync(join(memory, "deploy-notes.md"), "utf8")).toBe(MEMORY_FILE);

      // Nothing to rewrite on the next start.
      expect((await adoptCodeMemory(paths, indexer, config, projects)).pointers).toBe(0);
    } finally {
      indexer.close();
    }
  });

  it("writes the index for a directory the client created but never filled", async () => {
    const { projects, memory, paths, config } = sandbox("pointer");
    const indexer = Indexer.open(paths, config);
    try {
      expect(existsSync(join(memory, "MEMORY.md"))).toBe(false);
      await adoptCodeMemory(paths, indexer, config, projects);
      expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toContain("lives in agent-julia");
    } finally {
      indexer.close();
    }
  });
});

describe("absorbing what Claude Code wrote anyway", () => {
  it("moves the fact into the store and leaves a pointer to the page that holds it", async () => {
    const { projects, memory, paths, config } = sandbox("absorb");
    const file = join(memory, "deploy-notes.md");
    writeFileSync(file, MEMORY_FILE, "utf8");
    const indexer = Indexer.open(paths, config);

    try {
      const report = await adoptCodeMemory(paths, indexer, config, projects);
      expect(report.absorbed).toBe(1);
      expect(report.pending).toBe(0);

      const page = await readPage(paths, "code-memory-my-repo");
      expect(page).not.toBeNull();
      expect(page!.body).toContain("Deploys go out through the staging bucket first.");
      expect(page!.body).toContain("## deploy-notes");

      // The file stays, as a pointer: its description is the key the client
      // recalls on, so dropping it would remove the fact from recall instead of
      // redirecting it.
      const after = parseFrontmatter(readFileSync(file, "utf8"));
      expect(after.data.description).toBe("How this repo gets deployed");
      expect(after.content).toContain("code-memory-my-repo");
      expect(after.content).not.toContain("staging bucket");
      expect(readFileSync(`${file}.agent-julia-bak`, "utf8")).toBe(MEMORY_FILE);

      // A second start must not append the same fact again.
      const second = await adoptCodeMemory(paths, indexer, config, projects);
      expect(second.absorbed).toBe(0);
      const body = (await readPage(paths, "code-memory-my-repo"))!.body;
      expect(body.split("Deploys go out through the staging bucket first.").length - 1).toBe(1);

      // And the fact is searchable from every surface, which is the point.
      await indexer.sync();
      expect((await indexer.search("staging bucket", 5)).map((h) => h.id)).toContain("code-memory-my-repo");
    } finally {
      indexer.close();
    }
  });

  it("gives the directory back on uninstall", async () => {
    const { projects, memory, paths, config } = sandbox("absorb");
    const file = join(memory, "deploy-notes.md");
    writeFileSync(file, MEMORY_FILE, "utf8");
    const indexer = Indexer.open(paths, config);
    try {
      await adoptCodeMemory(paths, indexer, config, projects);
      const released = await releaseCodeMemory(projects);
      expect(released.pointers).toBe(1);
      expect(released.restored).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(MEMORY_FILE);
      expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).not.toContain("lives in agent-julia");
    } finally {
      indexer.close();
    }
  });

  it("does nothing at all when adoption is off", async () => {
    const { projects, memory, paths, config } = sandbox("off");
    writeFileSync(join(memory, "deploy-notes.md"), MEMORY_FILE, "utf8");
    const indexer = Indexer.open(paths, config);
    try {
      const report = await adoptCodeMemory(paths, indexer, config, projects);
      expect(report).toMatchObject({ projects: 0, pointers: 0, absorbed: 0 });
      expect(existsSync(join(memory, "MEMORY.md"))).toBe(false);
      expect(readFileSync(join(memory, "deploy-notes.md"), "utf8")).toBe(MEMORY_FILE);
    } finally {
      indexer.close();
    }
  });
});

describe("a project that documents itself", () => {
  it("is routed to, not copied in", async () => {
    const { dir, projects, memory, paths, config } = sandbox("pointer");
    const workingDir = join(dir, "my-repo");
    mkdirSync(join(workingDir, "_doc"), { recursive: true });
    writeFileSync(join(workingDir, "_doc", "architecture.md"), "# how it works", "utf8");
    writeFileSync(join(workingDir, "CLAUDE.md"), "# repo rules", "utf8");
    // A page claims the project and declares the source no directory listing
    // could reveal: a server that answers questions about it.
    await writePage(
      paths,
      "my-repo",
      [
        "---",
        `project: ${workingDir}`,
        "sources:",
        "  - kind: mcp",
        "    at: my-repo-docs",
        "    how: docs_search",
        "    about: the company documentation server",
        "---",
        "",
        "What this store knows about my-repo.",
      ].join("\n"),
      {},
    );

    const indexer = Indexer.open(paths, config);
    try {
      await adoptCodeMemory(paths, indexer, config, projects);
      const block = readFileSync(join(memory, "MEMORY.md"), "utf8");
      expect(block).toContain("This project's page in agent-julia is `my-repo`");
      expect(block).toContain("`my-repo-docs` MCP server");
      expect(block).toContain("docs_search");
      expect(block).toContain(join(workingDir, "_doc"));
      expect(block).toContain(join(workingDir, "CLAUDE.md"));
      expect(block).toContain("route to it");
    } finally {
      indexer.close();
    }
  });
});

describe("a directory that keeps a knowledge base of its own", () => {
  it("is left alone until the user says otherwise", async () => {
    // 154 files in one repo is not a handful of strays; folding it into one page
    // would bury a split someone made on purpose.
    const { projects, memory, paths, config } = sandbox("absorb");
    for (let i = 0; i < ABSORB_BATCH_LIMIT + 1; i++) {
      writeFileSync(join(memory, `note-${i}.md`), `---\nname: note-${i}\n---\n\nFact number ${i}.\n`, "utf8");
    }
    const indexer = Indexer.open(paths, config);
    try {
      const report = await adoptCodeMemory(paths, indexer, config, projects);
      expect(report.absorbed).toBe(0);
      expect(report.overflow).toBe(1);
      expect(report.pending).toBe(ABSORB_BATCH_LIMIT + 1);
      // The pointer still goes in: saying where the memory lives is not the
      // same as moving it.
      expect(report.pointers).toBe(1);
      expect(readFileSync(join(memory, "note-0.md"), "utf8")).toContain("Fact number 0.");

      const forced = await adoptCodeMemory(paths, indexer, config, projects, true);
      expect(forced.absorbed).toBe(ABSORB_BATCH_LIMIT + 1);
      expect((await readPage(paths, "code-memory-my-repo"))!.body).toContain("Fact number 25.");
    } finally {
      indexer.close();
    }
  });
});

describe("resolving which working directory a memory belongs to", () => {
  it("resolves a name that contains the separator it was slugified with", () => {
    const dir = tempDir("aj-slug-");
    const workingDir = join(dir, "agent-julia");
    mkdirSync(workingDir);
    expect(decodeWorkingDir(slugify(workingDir))).toBe(workingDir);
    expect(decodeWorkingDir(slugify(join(dir, "gone-for-good")))).toBeNull();
  });

  it("resolves a name whose other characters were slugified to a dash too", () => {
    // Not only separators: "_", "." and any non-ASCII letter become a dash as
    // well, so the dash in the slug cannot be spelled back literally.
    const dir = tempDir("aj-slug-");
    for (const name of ["my_repo", ".config", "Kraków notes"]) {
      const workingDir = join(dir, name, "sub");
      mkdirSync(workingDir, { recursive: true });
      expect(decodeWorkingDir(slugify(workingDir))).toBe(workingDir);
    }
  });
});

describe("what doctor sees", () => {
  it("counts the directories that point here and the facts that do not", async () => {
    const { projects, memory, paths, config } = sandbox("pointer");
    writeFileSync(join(memory, "deploy-notes.md"), MEMORY_FILE, "utf8");
    expect(await codeMemoryStatus(projects)).toEqual({ projects: 1, adopted: 0, loose: 1 });
    const indexer = Indexer.open(paths, config);
    try {
      await adoptCodeMemory(paths, indexer, config, projects);
    } finally {
      indexer.close();
    }
    expect(await codeMemoryStatus(projects)).toEqual({ projects: 1, adopted: 1, loose: 1 });
  });
});
