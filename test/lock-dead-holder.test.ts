import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deadHolder, withStoreLock } from "../src/store/lock.js";

// A pid that existed a moment ago and does not now.
const gonePid = (): number =>
  Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);

function leaveLock(root: string, owner: string): void {
  const dir = join(root, ".agent-julia", "store.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner"), owner);
}

describe("a store lock left by a process that is gone", () => {
  it("is taken at once when the holder ran on this machine", async () => {
    const root = mkdtempSync(join(tmpdir(), "aj-dead-"));
    leaveLock(root, `${gonePid()}:dead-token@${hostname()}`);
    const started = Date.now();
    expect(await withStoreLock(root, async () => "mine", { waitMs: 5_000 })).toBe("mine");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("is left to the idle rule when the holder ran on another machine, or is still alive", async () => {
    const root = mkdtempSync(join(tmpdir(), "aj-dead-"));
    leaveLock(root, `${gonePid()}:dead-token@some-other-mac`);
    expect(await withStoreLock(root, async () => "mine", { waitMs: 300 })).toBeNull();

    expect(deadHolder(`${process.pid}:t@${hostname()}`)).toBe(false);
    expect(deadHolder(`${process.ppid}:t@${hostname()}`)).toBe(false);
    // Written by 0.1.44 and earlier: no host, so no guessing.
    expect(deadHolder(`${gonePid()}:old-format-token`)).toBe(false);
    expect(deadHolder(null)).toBe(false);
  });
});
