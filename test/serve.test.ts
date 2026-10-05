import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "src", "index.ts");
const HOOK = new URL("./fixtures/fake-transformers-hook.mjs", import.meta.url).href;

interface Entry {
  pid: number;
  event: "import" | "pipeline" | "batch";
  dtype?: string;
  n?: number;
}

function entries(log: string): Entry[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

// The real server, as a Claude client starts it, with the model package
// resolved to a fake that records which process imported it. A server process
// that loads the model keeps the memory ONNX Runtime allocates for as long as
// its session lives (1.3-5.4 GB measured), and there is one server per session.
describe("serve keeps the embedding model out of its own process", () => {
  let client: Client | null = null;
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = null;
  });

  it("embeds in a child, in batches of at most 8, and the child goes when the server does", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aj-serve-"));
    const home = join(tmp, "home");
    const memoryDir = join(tmp, "memory");
    mkdirSync(home, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    const configPath = join(tmp, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        memoryDir,
        git: false,
        search: "hybrid",
        surfaces: ["code"],
        codeMemory: "off",
        embedding: { provider: "local", model: "fake/model", dims: 4 },
      }),
    );
    const log = join(tmp, "fake.log");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "--import", HOOK, ENTRY, "serve"],
      cwd: ROOT,
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        // Startup refreshes skills and persona blocks under the home directory.
        HOME: home,
        USERPROFILE: home,
        AGENT_JULIA_CONFIG: configPath,
        AJ_FAKE_TRANSFORMERS_LOG: log,
      },
    });
    client = new Client({ name: "test-client", version: "test" });
    await client.connect(transport);
    const serverPid = transport.pid!;
    expect(serverPid).toBeGreaterThan(0);

    // Twelve sections long enough not to be folded together: twelve chunks.
    const body = Array.from(
      { length: 12 },
      (_, i) => `## Leg ${i + 1}\n\n${"Sailing along the coast, reefing early, keeping a log. ".repeat(5)}`,
    ).join("\n\n");
    const ingested = textOf(
      await client.callTool({ name: "ingest", arguments: { page: "sailing-log", content: body } }),
    );
    expect(ingested).toContain('"ok": true');

    const hits = textOf(await client.callTool({ name: "search", arguments: { query: "sailing" } }));
    expect(hits).toContain("sailing-log");

    const seen = entries(log);
    expect(seen.length).toBeGreaterThan(0);
    // The regression this guards against: the server importing the model itself.
    expect(seen.filter((e) => e.pid === serverPid)).toEqual([]);
    expect(seen.find((e) => e.event === "pipeline")?.dtype).toBe("q8");
    const batches = seen.filter((e) => e.event === "batch").map((e) => e.n!);
    expect(Math.max(...batches)).toBeLessThanOrEqual(8);
    expect(batches.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(13);

    const children = [...new Set(seen.map((e) => e.pid))];
    await client.close();
    client = null;
    await until(() => !alive(serverPid) && children.every((pid) => !alive(pid)));
  }, 60_000);
});
