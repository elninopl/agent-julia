import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withStoreLock } from "../src/store/lock.js";
import { withFileLock } from "../src/managed/lock.js";

// The one failure a lock cannot retry its way out of: it exists on disk, and
// then naming its holder fails — a full disk, a permission revoked mid-run.
// Both locks create the lock first and write the owner into it second, so this
// is the window where a lock can end up held by nobody.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const enospc = (): Error => Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  type AnyFn = (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    writeFile: async (path: string, ...rest: unknown[]): Promise<unknown> => {
      if (String(path).endsWith("owner")) throw enospc();
      return (actual.writeFile as unknown as AnyFn)(path, ...rest);
    },
    open: async (path: string, ...rest: unknown[]): Promise<unknown> => {
      const handle = (await (actual.open as unknown as AnyFn)(path, ...rest)) as {
        close: () => Promise<void>;
      };
      if (!String(path).endsWith(".agent-julia-lock")) return handle;
      return {
        writeFile: async (): Promise<void> => {
          throw enospc();
        },
        close: () => handle.close(),
      };
    },
  };
});

describe("a lock that cannot name its holder", () => {
  it("releases the managed lockfile instead of leaving it behind", async () => {
    // Left behind, it is a lock nobody holds and nobody releases: every later
    // writer waits out the whole staleness window before it may reclaim it.
    const dir = mkdtempSync(join(tmpdir(), "aj-lockfail-"));
    const file = join(dir, "CLAUDE.md");
    await expect(withFileLock(file, async () => "ran")).rejects.toThrow(/no space/);
    expect(existsSync(`${file}.agent-julia-lock`)).toBe(false);
  });

  it("releases the store lock directory instead of leaving it behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-lockfail2-"));
    await expect(withStoreLock(dir, async () => "ran")).rejects.toThrow(/no space/);
    expect(existsSync(join(dir, ".agent-julia", "store.lock"))).toBe(false);
  });
});
