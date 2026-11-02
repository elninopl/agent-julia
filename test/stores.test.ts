import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/tools/register.js";
import { Indexer } from "../src/index/indexer.js";
import { storePaths } from "../src/store/paths.js";
import { migrate } from "../src/migrations/runner.js";
import { Config, ConfigSchema } from "../src/config/schema.js";
import { configPath } from "../src/config/config.js";
import { MountedStore, mountExtraStores, splitStoreRef } from "../src/store/stores.js";
import { ensureGitRepo } from "../src/store/git.js";
import { runMaintenance } from "../src/maintenance/maintenance.js";
import { serverInstructions } from "../src/persona/startup.js";

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}
const jsonOf = <T = Record<string, unknown>>(result: unknown): T => JSON.parse(textOf(result)) as T;

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function newStore(prefix: string, git = false): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (git) await ensureGitRepo(dir);
  await migrate(ConfigSchema.parse({ memoryDir: dir, git, search: "fts" }), { persistConfig: false });
  return dir;
}

async function session(opts: { write?: boolean; git?: boolean; withStores?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "aj-home-"));
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const git = opts.git ?? false;
  const own = await newStore("aj-own-", git);
  const shared = await newStore("aj-team-", git);
  const docs = await newStore("aj-docs-", git);
  const withStores = opts.withStores ?? true;
  const config: Config = ConfigSchema.parse({
    memoryDir: own,
    git,
    search: "fts",
    ...(withStores
      ? {
          stores: [
            { name: "team", dir: shared, write: opts.write ?? true, git },
            { name: "docs", dir: docs, write: false, git },
          ],
        }
      : {}),
  });
  const paths = storePaths(own);
  const indexer = Indexer.open(paths, config);
  const stores = await mountExtraStores(config, { paths, indexer }, git);
  const server = new McpServer({ name: "agent-julia", version: "test" });
  registerTools(server, { config, paths, indexer, stores });
  const client = new Client({ name: "test-client", version: "test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanup.push(async () => {
    await client.close();
    for (const s of stores) s.indexer.close();
    indexer.close();
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { client, call, own, shared, docs, stores, config };
}

describe("page references with a store prefix", () => {
  const names = new Set(["team"]);
  it("select a mounted store only", () => {
    expect(splitStoreRef("team:pricing", names)).toEqual({ store: "team", page: "pricing" });
    expect(splitStoreRef("Team:Pricing", names)).toEqual({ store: "team", page: "Pricing" });
    expect(splitStoreRef("other:pricing", names)).toEqual({ store: null, page: "other:pricing" });
    expect(splitStoreRef("pricing", names)).toEqual({ store: null, page: "pricing" });
    expect(splitStoreRef("c:\\pages\\x.md", names)).toEqual({ store: null, page: "c:\\pages\\x.md" });
  });
});

describe("a server with no stores mounted", () => {
  it("offers ingest with exactly the arguments it always had", async () => {
    const { client } = await session({ withStores: false });
    const ingest = (await client.listTools()).tools.find((t) => t.name === "ingest")!;
    expect(Object.keys(ingest.inputSchema.properties ?? {}).sort()).toEqual(
      ["confirm", "content", "mode", "page", "status", "title"].sort(),
    );
    expect(ingest.description).not.toMatch(/shared store/i);
  });

  it("sends the same instructions as before", () => {
    const base = ConfigSchema.parse({ memoryDir: "/m" });
    expect(serverInstructions(base)).not.toMatch(/shared store/i);
    const mounted = ConfigSchema.parse({ memoryDir: "/m", stores: [{ name: "team", dir: "/t" }] });
    expect(serverInstructions(mounted)).toMatch(/Shared stores are mounted too: team \(read-only\)/);
  });
});

// Some of these keep both stores under git, and a commit on a Windows runner
// takes most of a second: the whole test runs close to the default 5 s there.
describe("mounted stores", { timeout: 30_000 }, () => {
  it("search all stores at once and label each hit with its store", async () => {
    const { call } = await session();
    await call("ingest", { page: "launch-plan", content: "Launch the trail app in Lisbon first." });
    await call("ingest", { page: "launch-budget", content: "Lisbon launch budget is shared with the team.", store: "team" });

    const hits = jsonOf<Array<{ id: string; store?: string }>>(await call("search", { query: "Lisbon launch" }));
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("launch-plan");
    expect(ids).toContain("team:launch-budget");
    expect(hits.find((h) => h.id === "team:launch-budget")!.store).toBe("team");
    expect(hits.find((h) => h.id === "launch-plan")!.store).toBeUndefined();
  });

  it("read, list and history address a page as store:page", async () => {
    const { call } = await session({ git: true });
    await call("ingest", { page: "pricing", content: "Team pricing: two tiers.", store: "team" });

    expect(textOf(await call("read", { page: "team:pricing" }))).toContain("two tiers");
    expect(textOf(await call("read", { page: "pricing" }))).toBe("No page found: pricing");

    const listed = jsonOf<{ total: number; pages: Array<{ id: string }> }>(await call("list", {}));
    expect(listed.pages.map((p) => p.id)).toContain("team:pricing");

    const history = jsonOf<{ page: string; changes: unknown[] }>(await call("history", { page: "team:pricing" }));
    expect(history.page).toBe("team:pricing");
    expect(history.changes.length).toBeGreaterThan(0);
  });

  it("write to the user's own memory unless a store is named", async () => {
    const { call, own, shared } = await session();
    const res = jsonOf(await call("ingest", { page: "private-note", content: "Only mine." }));
    expect(res.ok).toBe(true);
    expect(res.id).toBe("private-note");
    expect(existsSync(join(own, "pages", "private-note.md"))).toBe(true);
    expect(existsSync(join(shared, "pages", "private-note.md"))).toBe(false);
  });

  it("refuse a shared page id without the store argument", async () => {
    const { call, own, shared } = await session();
    await call("ingest", { page: "roadmap", content: "Q1: onboarding.", store: "team" });
    const res = jsonOf<{ ok: boolean; error: string }>(
      await call("ingest", { page: "team:roadmap", content: "my salary", mode: "append" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/shared store "team"/);
    expect(readFileSync(join(shared, "pages", "roadmap.md"), "utf8")).not.toContain("salary");
    expect(existsSync(join(own, "pages", "team-roadmap.md"))).toBe(false);
  });

  it("write to a named store and commit in its own repo", async () => {
    const { call, own, shared } = await session({ git: true });
    const ownCommits = execFileSync("git", ["rev-list", "--all", "--count"], { cwd: own, encoding: "utf8" }).trim();
    const res = jsonOf(await call("ingest", { page: "faq", content: "How to invite a partner.", store: "team" }));
    expect(res).toMatchObject({ ok: true, id: "team:faq", store: "team", committed: true });
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: shared, encoding: "utf8" }).trim()).toBe(
      "Update memory: faq",
    );
    expect(execFileSync("git", ["rev-list", "--all", "--count"], { cwd: own, encoding: "utf8" }).trim()).toBe(ownCommits);
    expect(readFileSync(join(shared, "index.md"), "utf8")).toContain("faq");
    expect(readFileSync(join(own, "index.md"), "utf8")).not.toContain("faq");
  });

  it("refuse writes and archiving in a read-only store", async () => {
    const { call, docs } = await session();
    const res = jsonOf<{ ok: boolean; error: string }>(
      await call("ingest", { page: "x", content: "nope", store: "docs" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/read-only/);
    expect(existsSync(join(docs, "pages", "x.md"))).toBe(false);

    writeFileSync(join(docs, "pages", "manual.md"), "# Manual\n");
    expect(textOf(await call("archive", { page: "docs:manual" }))).toMatch(/read-only/);
    expect(existsSync(join(docs, "pages", "manual.md"))).toBe(true);
  });

  it("refuse an unknown store", async () => {
    const { call } = await session();
    const res = jsonOf<{ ok: boolean; error: string }>(await call("ingest", { page: "x", content: "y", store: "nope" }));
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/No store named "nope"/);
  });

  it("keep a prefixed id inside its store's pages directory", async () => {
    const { call, shared } = await session();
    const res = jsonOf<{ ok: boolean; path: string }>(
      await call("ingest", { page: "team:../../../escape", content: "contained", store: "team" }),
    );
    expect(res.ok).toBe(true);
    expect(res.path.startsWith(join(shared, "pages"))).toBe(true);
    expect(textOf(await call("read", { page: "team:../../../../etc/passwd" }))).toMatch(/^No page found/);
  });

  it("follow [[store:page]] links across stores, and keep bare links in their store", async () => {
    const { call, config, stores } = await session();
    await call("ingest", { page: "pricing", content: "Two tiers.", store: "team" });
    await call("ingest", { page: "my-take", content: "I prefer [[team:pricing]] over [[my-other]]." });

    const rel = jsonOf<{ links: string[]; backlinks: string[] }>(await call("related", { page: "team:pricing" }));
    expect(rel.backlinks).toEqual(["my-take"]);
    const fwd = jsonOf<{ links: string[] }>(await call("related", { page: "my-take" }));
    expect(fwd.links.sort()).toEqual(["my-other", "team:pricing"]);

    // A link into a mounted store is not an orphan of the primary.
    const own = storePaths(config.memoryDir);
    const primaryIndexer = Indexer.open(own, config);
    cleanup.push(() => primaryIndexer.close());
    const report = await runMaintenance(own, primaryIndexer, config, "auto");
    expect(report.orphanLinks.map((o) => o.to)).toEqual(["my-other"]);
    expect(stores.length).toBe(2);
  });

  it("run maintenance per store and report each", async () => {
    const { call } = await session();
    const out = jsonOf<{ stores: Record<string, { indexAdded?: number; error?: string }> }>(
      await call("maintenance", {}),
    );
    expect(Object.keys(out.stores).sort()).toEqual(["docs", "team"]);
    expect(out.stores.team!.error).toBeUndefined();
  });
});

describe("mounting", () => {
  it("skips a missing or doubly mounted directory and never rewrites the config", async () => {
    const own = await newStore("aj-own-");
    const team = await newStore("aj-team-");
    const config = ConfigSchema.parse({
      memoryDir: own,
      git: false,
      search: "fts",
      stores: [
        { name: "team", dir: team },
        { name: "again", dir: team },
        { name: "self", dir: own },
        { name: "gone", dir: join(own, "does-not-exist") },
      ],
    });
    const before = existsSync(configPath()) ? readFileSync(configPath(), "utf8") : null;
    const paths = storePaths(own);
    const indexer = Indexer.open(paths, config);
    const stores: MountedStore[] = await mountExtraStores(config, { paths, indexer }, false);
    cleanup.push(() => {
      for (const s of stores) s.indexer.close();
      indexer.close();
    });
    expect(stores.map((s) => s.name)).toEqual(["team"]);
    expect(stores[0]!.write).toBe(false);
    expect(stores[0]!.paths.personaRoot).toBe(own);
    expect(existsSync(configPath()) ? readFileSync(configPath(), "utf8") : null).toBe(before);
  });

  it("initialises an empty directory as a store without touching the config", async () => {
    const own = await newStore("aj-own-");
    const fresh = mkdtempSync(join(tmpdir(), "aj-fresh-"));
    const config = ConfigSchema.parse({ memoryDir: own, git: false, search: "fts", stores: [{ name: "fresh", dir: fresh }] });
    const before = existsSync(configPath()) ? readFileSync(configPath(), "utf8") : null;
    const paths = storePaths(own);
    const indexer = Indexer.open(paths, config);
    const stores = await mountExtraStores(config, { paths, indexer }, false);
    cleanup.push(() => {
      for (const s of stores) s.indexer.close();
      indexer.close();
    });
    expect(existsSync(join(fresh, "index.md"))).toBe(true);
    expect(existsSync(configPath()) ? readFileSync(configPath(), "utf8") : null).toBe(before);
  });
});
