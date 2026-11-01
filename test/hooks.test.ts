import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, Config } from "../src/config/schema.js";
import { hookPaths, hookStatus, installHooks, refreshHookScript, uninstallHooks } from "../src/hooks/hooks.js";
import { HOOK_SCRIPT_NAME } from "../src/hooks/script.js";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

const FOREIGN = { type: "command", command: "echo someone-else" };

function setup(capture: Partial<Config["capture"]> = {}) {
  const root = tmp("aj-hooks-");
  const claudeDir = join(root, "claude");
  const dir = join(root, "cfg", "hooks");
  const record = join(root, "claude-calls");
  const fake = join(root, "fake-claude.mjs");
  // Stands in for `claude -p`: records how it was started and what it read.
  writeFileSync(
    fake,
    [
      'import { appendFileSync } from "node:fs";',
      'let input = "";',
      'process.stdin.on("data", (d) => (input += d));',
      'process.stdin.on("end", () => {',
      `  appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), guard: process.env.AGENT_JULIA_HOOK_CHILD, input }) + "\\n");`,
      '  console.log("saved: atlas");',
      "});",
    ].join("\n"),
  );
  const config = ConfigSchema.parse({ memoryDir: join(root, "mem"), capture: { nudgeEveryTurns: 3, ...capture } });
  const opts = {
    claudeDir,
    dir,
    claudeCommand: [process.execPath, fake],
    server: { command: "node", args: ["agent-julia", "serve"] },
    node: process.execPath,
    persistConfig: false,
  };
  return { root, claudeDir, dir, record, config, opts, settings: join(claudeDir, "settings.json"), script: join(dir, HOOK_SCRIPT_NAME) };
}

function runHook(script: string, mode: string, input: object, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, mode], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const line = (role: "user" | "assistant", text: string) =>
  JSON.stringify(
    role === "user"
      ? { type: "user", message: { role, content: text } }
      : { type: "assistant", message: { role, content: [{ type: "text", text }, { type: "tool_use", name: "Bash", input: {} }] } },
  ) + "\n";

describe("capture hooks", () => {
  it("install next to other hooks, idempotently, and uninstall only their own", async () => {
    const t = setup();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(t.claudeDir, { recursive: true });
    writeFileSync(t.settings, JSON.stringify({ model: "opus", hooks: { UserPromptSubmit: [{ hooks: [FOREIGN] }] } }, null, 2));

    const first = await installHooks(t.config, t.opts);
    expect(first.events).toEqual(["UserPromptSubmit", "PreCompact", "SessionEnd"]);
    expect(first.settingsChanged).toBe(true);
    const s = JSON.parse(readFileSync(t.settings, "utf8"));
    expect(s.model).toBe("opus");
    expect(s.hooks.UserPromptSubmit).toHaveLength(2);
    expect(s.hooks.UserPromptSubmit[0].hooks[0]).toEqual(FOREIGN);
    expect(s.hooks.UserPromptSubmit[1].hooks[0].command).toContain(HOOK_SCRIPT_NAME);
    expect(s.hooks.SessionEnd[0].hooks[0].async).toBe(true);
    expect(existsSync(`${t.settings}.agent-julia-bak`)).toBe(true);

    expect((await installHooks(t.config, t.opts)).settingsChanged).toBe(false);
    expect(await hookStatus(first.config, t.opts)).toMatchObject({
      enabled: true,
      events: ["UserPromptSubmit", "PreCompact", "SessionEnd"],
      script: "current",
    });

    await uninstallHooks(t.config, t.opts);
    const after = JSON.parse(readFileSync(t.settings, "utf8"));
    expect(after).toEqual({ model: "opus", hooks: { UserPromptSubmit: [{ hooks: [FOREIGN] }] } });
    expect(existsSync(t.script)).toBe(false);
  });

  it("leave out the extraction hooks when extraction is off", async () => {
    const t = setup({ extractOnCompact: false });
    const res = await installHooks(t.config, t.opts);
    expect(res.events).toEqual(["UserPromptSubmit"]);
  });

  it("go where CLAUDE_CONFIG_DIR points", () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/accounts/work/.claude";
    try {
      expect(hookPaths().settingsFile).toBe(join("/accounts/work/.claude", "settings.json"));
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it("refuse to rewrite settings that are not valid JSON", async () => {
    const t = setup();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(t.claudeDir, { recursive: true });
    writeFileSync(t.settings, "{ not json");
    await expect(installHooks(t.config, t.opts)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(t.settings, "utf8")).toBe("{ not json");
  });

  it("remind the agent to save a voice correction and, every few turns, a decision", async () => {
    const t = setup();
    await installHooks(t.config, t.opts);
    const session = { session_id: "s-1", hook_event_name: "UserPromptSubmit" };

    const correction = runHook(t.script, "prompt", { ...session, prompt: "Nie pisz „stoi”, to źle brzmi." });
    expect(JSON.parse(correction.stdout).hookSpecificOutput.additionalContext).toMatch(/correct_voice/);

    expect(runHook(t.script, "prompt", { ...session, prompt: "Run the tests." }).stdout).toBe("");
    const third = runHook(t.script, "prompt", { ...session, prompt: "Ship it." });
    const ctx = JSON.parse(third.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/ingest/);
    expect(ctx).not.toMatch(/correct_voice/);

    expect(runHook(t.script, "prompt", { ...session, prompt: "nie pisz tak" }, { AGENT_JULIA_HOOK_CHILD: "1" }).stdout).toBe("");
  });

  it("hand only the new part of a transcript to a background claude, once", async () => {
    const t = setup();
    await installHooks(t.config, t.opts);
    const transcript = join(t.root, "session.jsonl");
    writeFileSync(
      transcript,
      line("user", "We decided to launch Atlas in March, after the pricing test. ".repeat(5)) +
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "SECRET TOOL OUTPUT" }] } }) +
        "\n" +
        line("assistant", "Noted. <system-reminder>internal</system-reminder> Atlas launches in March. ".repeat(4)),
    );
    const payload = { session_id: "s-2", transcript_path: transcript, hook_event_name: "PreCompact" };

    runHook(t.script, "extract", payload);
    await until(() => existsSync(t.record));
    const calls = () => readFileSync(t.record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const [call] = calls();
    expect(call.guard).toBe("1");
    expect(call.args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--mcp-config", "--allowedTools", "--settings"]));
    expect(call.args.join(" ")).toContain("mcp__agent-julia__ingest");
    expect(call.input).toContain("USER: We decided to launch Atlas in March");
    expect(call.input).toContain("ASSISTANT: Noted.");
    expect(call.input).not.toContain("SECRET TOOL OUTPUT");
    expect(call.input).not.toContain("internal");

    const mcp = JSON.parse(readFileSync(join(t.dir, "extract-mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["agent-julia"]);
    expect(JSON.parse(readFileSync(join(t.dir, "extract-settings.json"), "utf8"))).toEqual({ disableAllHooks: true });

    // SessionEnd right after: nothing new, nothing sent.
    runHook(t.script, "extract", { ...payload, hook_event_name: "SessionEnd" });
    await new Promise((r) => setTimeout(r, 500));
    expect(calls()).toHaveLength(1);

    appendFileSync(transcript, line("user", "Also: the Atlas launch moves to April because of the audit. ".repeat(8)));
    runHook(t.script, "extract", { ...payload, hook_event_name: "SessionEnd" });
    await until(() => calls().length === 2);
    expect(calls()[1].input).toContain("moves to April");
    expect(calls()[1].input).not.toContain("launch Atlas in March");

    await until(() => readdirSync(join(t.dir, "extract")).every((f) => !f.endsWith(".job")));
    expect(readFileSync(join(t.root, "cfg", "hooks.log"), "utf8")).toMatch(/extract finished \(exit 0\): saved: atlas/);
  });

  it("rewrite the script at boot when the config changes it", async () => {
    const t = setup();
    const { config } = await installHooks(t.config, t.opts);
    expect(await refreshHookScript(config, { dir: t.dir })).toBe(false);
    const changed = { ...config, capture: { ...config.capture!, nudgeEveryTurns: 7 } };
    expect(await refreshHookScript(changed, { dir: t.dir })).toBe(true);
    expect(readFileSync(t.script, "utf8")).toContain('"nudgeEveryTurns": 7');
    expect(await refreshHookScript({ ...changed, capture: { ...changed.capture, hooks: false } }, { dir: t.dir })).toBe(false);
  });
});
