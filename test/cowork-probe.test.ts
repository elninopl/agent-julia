import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeCoworkSession } from "../src/surfaces/cowork-probe.js";

// Claude Desktop's layout: <root>/<account>/<org>/<session>/.claude/CLAUDE.md,
// the session named local_<uuid> by older builds and a short hex id by newer.
function tree(): string {
  return mkdtempSync(join(tmpdir(), "aj-probe-"));
}

function block(layout: 1 | 2, body = ""): string {
  const head = layout === 2 ? "agent-julia paste, layout 2" : "# Persona";
  return (
    "<!-- agent-julia:persona-core:start — managed block, do not edit by hand -->\n" +
    `${head}\n${body}\n` +
    "<!-- agent-julia:persona-core:end -->\n"
  );
}

// content: the seeded file's text, or null for a session that wrote none.
function session(root: string, name: string, content: string | null, day: string): void {
  const dir = join(root, "acct", "org", name, ".claude");
  mkdirSync(dir, { recursive: true });
  const at = new Date(`${day}T08:00:00Z`);
  if (content !== null) {
    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, content, "utf8");
    utimesSync(file, at, at);
  }
  utimesSync(dir, at, at);
}

describe("what the newest Cowork session was seeded with", () => {
  it("reports nothing when the newest session's file is empty, not an older session's block", async () => {
    // The newest few files being empty used to send the probe further back, to
    // a layout-1 block weeks old, and doctor then asked for a re-paste.
    const root = tree();
    session(root, "local_aaaa", block(1), "2026-08-20");
    session(root, "local_bbbb", "", "2026-09-30");
    session(root, "1a2b3c4d", "", "2026-10-01");

    expect(await probeCoworkSession([root])).toEqual({ status: "none", newest: "2026-10-01" });
  });

  it("counts a session that wrote no file at all as the newest", async () => {
    const root = tree();
    session(root, "local_aaaa", block(1), "2026-09-16");
    session(root, "5e6f7a8b", null, "2026-10-05");

    expect(await probeCoworkSession([root])).toEqual({ status: "none", newest: "2026-10-05" });
  });

  it("reads the newest block and how long it has gone unchanged", async () => {
    const root = tree();
    session(root, "local_0001", block(1), "2026-08-01");
    session(root, "local_0002", block(2, "- one rule"), "2026-09-01");
    session(root, "local_0003", "", "2026-09-10");
    session(root, "local_0004", block(2, "- one rule"), "2026-09-20");

    const probe = await probeCoworkSession([root]);
    expect(probe).toMatchObject({ status: "found", layout: 2, newest: "2026-09-20", unchangedSince: "2026-09-01" });
  });

  it("looks only where sessions keep their instructions", async () => {
    // The same level also holds caches and settings directories, and a session
    // keeps other CLAUDE.md files around (outputs, memory). None of those are
    // what the session was seeded with, however new they are.
    const root = tree();
    session(root, "local_0001", block(2), "2026-09-01");
    const org = join(root, "acct", "org");
    mkdirSync(join(org, "memory"), { recursive: true });
    writeFileSync(join(org, "memory", "CLAUDE.md"), block(1), "utf8");
    mkdirSync(join(org, "local_0001", "outputs"), { recursive: true });
    writeFileSync(join(org, "local_0001", "outputs", "CLAUDE.md"), block(1), "utf8");
    mkdirSync(join(org, "rpm"), { recursive: true });

    expect(await probeCoworkSession([root])).toMatchObject({ status: "found", layout: 2, newest: "2026-09-01" });
  });

  it("says none when there is no session tree at all", async () => {
    expect(await probeCoworkSession([join(tree(), "missing")])).toEqual({ status: "none" });
  });
});
