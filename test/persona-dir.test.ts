import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/tools/register.js";
import { Indexer } from "../src/index/indexer.js";
import { primaryPaths, storePaths } from "../src/store/paths.js";
import { migrate } from "../src/migrations/runner.js";
import { ConfigSchema } from "../src/config/schema.js";
import { composeCore } from "../src/persona/compose.js";
import { execFileSync } from "node:child_process";
import { ensureGitRepo } from "../src/store/git.js";

const git = async (cwd: string, args: string[]): Promise<string> =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

// A process whose memory is one store and whose voice is another's: the
// persona files are read from personaDir, and corrections land there too.
describe("personaDir", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  function twoStores() {
    const memory = mkdtempSync(join(tmpdir(), "aj-shared-"));
    const persona = mkdtempSync(join(tmpdir(), "aj-persona-"));
    writeFileSync(join(persona, "persona.md"), "Answer like a ship's navigator.\n");
    writeFileSync(join(persona, "voice-corrections.md"), "# Voice corrections\n\n- 2026-10-01 — never say 'synergy'\n");
    writeFileSync(join(memory, "persona.md"), "Answer like a pastry chef.\n");
    return { memory, persona };
  }

  it("leaves the paths of a config without it exactly as before", () => {
    const cfg = ConfigSchema.parse({ memoryDir: "/m" });
    expect(primaryPaths(cfg)).toEqual(storePaths("/m"));
  });

  it("composes the core from the persona directory, not the memory store", async () => {
    const { memory, persona } = twoStores();
    const cfg = ConfigSchema.parse({ memoryDir: memory, personaDir: persona, stylePreset: "custom", git: false });
    const core = await composeCore(primaryPaths(cfg), cfg);
    expect(core.text).toContain("ship's navigator");
    expect(core.text).toContain("synergy");
    expect(core.text).not.toContain("pastry chef");
  });

  async function session(git: boolean) {
    const home = mkdtempSync(join(tmpdir(), "aj-home-"));
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const { memory, persona } = twoStores();
    if (git) {
      await ensureGitRepo(memory);
      await ensureGitRepo(persona);
    }
    // personaDir is another agent-julia store, set up by its own server.
    await migrate(ConfigSchema.parse({ memoryDir: persona, git, search: "fts" }));
    const config = ConfigSchema.parse({ memoryDir: memory, personaDir: persona, stylePreset: "custom", git, search: "fts" });
    await migrate(config);
    const paths = primaryPaths(config);
    const indexer = Indexer.open(paths, config);
    const server = new McpServer({ name: "agent-julia", version: "test" });
    registerTools(server, { config, paths, indexer });
    const client = new Client({ name: "test-client", version: "test" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    cleanup = async () => {
      await client.close();
      indexer.close();
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    return { client, memory, persona };
  }

  it("writes and withdraws corrections in the persona directory", async () => {
    const { client, memory, persona } = await session(false);

    await client.callTool({ name: "correct_voice", arguments: { note: "No exclamation marks." } });
    expect(readFileSync(join(persona, "voice-corrections.md"), "utf8")).toContain("No exclamation marks.");
    expect(existsSync(join(memory, "voice-corrections.md"))).toBe(false);

    const core = textOf(await client.callTool({ name: "get_core", arguments: {} }));
    expect(core).toContain("No exclamation marks.");
    expect(core).toContain("ship's navigator");

    await client.callTool({ name: "retract_correction", arguments: { match: "exclamation" } });
    expect(textOf(await client.callTool({ name: "get_core", arguments: {} }))).not.toContain("No exclamation marks.");
  });

  it("commits a correction in the persona store's repo and leaves the memory store's alone", async () => {
    const { client, memory, persona } = await session(true);
    const memoryHead = await git(memory, ["rev-list", "--all", "--count"]).catch(() => "0");

    await client.callTool({ name: "correct_voice", arguments: { note: "Short sentences." } });

    expect(await git(persona, ["log", "-1", "--format=%s"])).toBe("Update memory: voice correction");
    expect(await git(persona, ["status", "--porcelain"])).toBe("");
    expect(await git(memory, ["rev-list", "--all", "--count"]).catch(() => "0")).toBe(memoryHead);
  });
});
