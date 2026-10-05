import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A seam in the middle of an absorb: what Claude Code might do while the fact
// is being written into the store. Pass-through unless a test sets it.
const seam = vi.hoisted(() => ({ afterIngest: null as null | (() => void) }));
vi.mock("../src/store/ingest.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/store/ingest.js")>();
  return {
    ...real,
    ingest: async (...args: Parameters<typeof real.ingest>) => {
      const result = await real.ingest(...args);
      seam.afterIngest?.();
      return result;
    },
  };
});

const { adoptCodeMemory } = await import("../src/surfaces/code-memory.js");
const { Indexer } = await import("../src/index/indexer.js");
const { storePaths } = await import("../src/store/paths.js");
const { readPage } = await import("../src/store/markdown.js");
const { ConfigSchema } = await import("../src/config/schema.js");

const FACT = `---
name: deploy-notes
description: How this repo gets deployed
---

Deploys go out through the staging bucket first.
`;

const EDITED = `---
name: deploy-notes
description: How this repo gets deployed
---

Deploys now go straight to production on Fridays.
`;

function sandbox() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "aj-absorb-")));
  const workingDir = join(dir, "atlas");
  mkdirSync(workingDir);
  const projects = join(dir, "projects");
  const memory = join(projects, workingDir.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  mkdirSync(memory, { recursive: true });
  const store = join(dir, "store");
  mkdirSync(store);
  const config = ConfigSchema.parse({ memoryDir: store, git: false, search: "fts", codeMemory: "absorb" });
  return { projects, memory, paths: storePaths(store), config };
}

afterEach(() => {
  seam.afterIngest = null;
});

describe("absorbing while something else touches the same file", () => {
  it("leaves a version written mid-absorb in place, and takes it on the next run", async () => {
    const { projects, memory, paths, config } = sandbox();
    const file = join(memory, "deploy-notes.md");
    writeFileSync(file, FACT, "utf8");
    const indexer = Indexer.open(paths, config);
    try {
      // The client rewrites the fact while the old version is being stored.
      seam.afterIngest = () => writeFileSync(file, EDITED, "utf8");
      const first = await adoptCodeMemory(paths, indexer, config, projects);
      seam.afterIngest = null;
      expect(first.absorbed).toBe(0);
      expect(first.pending).toBe(1);
      // Not swapped for a pointer, and not parked in a backup only.
      expect(readFileSync(file, "utf8")).toBe(EDITED);
      expect(existsSync(`${file}.agent-julia-bak`)).toBe(false);

      const second = await adoptCodeMemory(paths, indexer, config, projects);
      expect(second.absorbed).toBe(1);
      const body = (await readPage(paths, "code-memory-atlas"))!.body;
      expect(body).toContain("staging bucket");
      expect(body).toContain("straight to production");
      expect(readFileSync(file, "utf8")).toContain("<!-- agent-julia:absorbed");
    } finally {
      indexer.close();
    }
  });

  it("appends a fact once when two runs absorb it at the same time", async () => {
    // A boot and a `sync` side by side: both used to find the fact missing from
    // the page and both appended it.
    const { projects, memory, paths, config } = sandbox();
    writeFileSync(join(memory, "deploy-notes.md"), FACT, "utf8");
    const indexer = Indexer.open(paths, config);
    try {
      const [a, b] = await Promise.all([
        adoptCodeMemory(paths, indexer, config, projects),
        adoptCodeMemory(paths, indexer, config, projects),
      ]);
      expect(a.absorbed + b.absorbed).toBe(1);
      expect(a.failed + b.failed).toBe(0);
      const body = (await readPage(paths, "code-memory-atlas"))!.body;
      expect(body.split("Deploys go out through the staging bucket first.").length - 1).toBe(1);
    } finally {
      indexer.close();
    }
  });
});
