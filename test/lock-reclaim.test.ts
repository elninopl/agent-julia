import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every waiter that finds the same dead lock decides it is stale. The first
// one cleared it and took the lock, and a second one, a beat later, cleared
// that fresh lock and took it too: two holders at once. Real timing makes the
// "beat later" a matter of luck, so each removal of a lock here lands a little
// after the one before it, which is the order the race needs.
const slow = vi.hoisted(() => ({ removals: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rm: async (...args: Parameters<typeof real.rm>) => {
      const path = String(args[0]);
      if (path.endsWith(".lock") || path.endsWith("-lock")) {
        const wait = 20 * slow.removals++;
        await new Promise((r) => setTimeout(r, wait));
      }
      return real.rm(...args);
    },
  };
});

const { withStoreLock } = await import("../src/store/lock.js");
const { withFileLock } = await import("../src/managed/lock.js");

beforeEach(() => {
  slow.removals = 0;
});

async function contend(n: number, take: (work: () => Promise<void>) => Promise<unknown>): Promise<number> {
  let active = 0;
  let most = 0;
  const work = async () => {
    active++;
    most = Math.max(most, active);
    await new Promise((r) => setTimeout(r, 60));
    active--;
  };
  await Promise.all(Array.from({ length: n }, () => take(work)));
  return most;
}

const longAgo = new Date(Date.now() - 10 * 60_000);

describe("reclaiming a lock its holder left behind", () => {
  it("lets one waiter at a time through a stale store lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-stale-"));
    const lockDir = join(dir, ".agent-julia", "store.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner"), "1:gone", "utf8");
    utimesSync(join(lockDir, "owner"), longAgo, longAgo);
    utimesSync(lockDir, longAgo, longAgo);

    expect(await contend(4, (work) => withStoreLock(dir, work))).toBe(1);
    expect(readdirSync(join(dir, ".agent-julia"))).toEqual([]);
  }, 20_000);

  it("lets one writer at a time through a stale file lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-stale-file-"));
    const file = join(dir, "CLAUDE.md");
    const lock = `${file}.agent-julia-lock`;
    writeFileSync(lock, "1:gone", "utf8");
    utimesSync(lock, longAgo, longAgo);

    expect(await contend(4, (work) => withFileLock(file, work))).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  }, 20_000);
});
