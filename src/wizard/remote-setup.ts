import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { configExists, loadConfig, saveConfig } from "../config/config.js";
import { Config, ConfigSchema, Surface } from "../config/schema.js";
import {
  CoreSnapshot,
  RemoteError,
  UpstreamLink,
  fetchCore,
  normalizeRemoteUrl,
  remoteTokenFile,
  saveRemoteToken,
} from "../remote/remote.js";
import { injectedCoreFrom } from "../persona/startup.js";
import { install } from "./register.js";
import { Prompter } from "./prompt.js";
import { c, info, note, ok, step, summary } from "./ui.js";

const STEPS = 3;

// The wizard for a machine that keeps no memory of its own: where the server
// is, the token it wants, and which Claude apps to wire to it. The persona's
// identity comes from the server.
export async function runRemoteSetup(p: Prompter): Promise<void> {
  // A config replaced by this one keeps its memoryDir: switching back to a
  // local setup later finds the old store where it was.
  const previous = configExists() ? await loadConfig().catch(() => null) : null;

  let url: URL | null = null;
  let token = "";
  let core: CoreSnapshot | null = null;
  while (!core) {
    step(1, STEPS, "Server", "the address of the agent-julia server to connect to");
    note("The machine that runs `agent-julia serve --http`, or the public address in front of it.");
    for (;;) {
      const raw = await p.text({ example: "https://julia.example.com or http://studio.local:8787", def: url?.origin });
      try {
        url = normalizeRemoteUrl(raw);
        break;
      } catch {
        note("That is not a URL. Start it with https:// or http://.");
      }
    }

    step(2, STEPS, "Token", "what this machine shows the server to be let in");
    note("Made on the server with `agent-julia server token add <name>` and shown there once. Leave it blank for a server that asks for none.");
    token = await p.secret();

    const link = new UpstreamLink({ url, token: token || null, tokenSource: token ? "the wizard" : null });
    try {
      core = await fetchCore(link);
    } catch (err) {
      console.log("");
      note(err instanceof RemoteError ? err.message : (err as Error).message);
      if (!(await p.confirm("Try again?", true))) {
        info("Nothing was written.");
        return;
      }
    } finally {
      await link.close();
    }
  }
  const id = core.identity;
  ok(`Connected. The server's persona is ${c.bold(id?.name ?? "unnamed")}${id ? ` · ${id.pronouns} · speaks ${id.language}` : ""}.`);

  step(3, STEPS, "Where to use it", "register the server with your Claude apps on this machine");
  console.log("");
  const surfaces: Surface[] = [];
  if (await p.confirm("Claude Code (the terminal CLI)?", true)) surfaces.push("code");
  if (await p.confirm("Claude Desktop (Cowork)?", true)) surfaces.push("cowork");

  const config: Config = ConfigSchema.parse({
    ...(id ?? {}),
    memoryDir: previous?.memoryDir ?? join(homedir(), "agent-julia-memory"),
    surfaces,
    remote: { url: url!.href },
  });

  summary("Here's your setup", [
    ["agent", `${config.name} · ${config.pronouns} · speaks ${config.language} (from the server)`],
    ["server", url!.href],
    ["token", token ? `kept in ${remoteTokenFile()}, readable by you only` : "none"],
    ["surfaces", surfaces.length ? surfaces.join(" · ") : "(none)"],
  ]);
  console.log("");
  if (!(await p.confirm("Looks good — set it up?", true))) {
    info("No problem. Nothing was written.");
    return;
  }

  if (token) await saveRemoteToken(token);
  else if (existsSync(remoteTokenFile())) await rm(remoteTokenFile(), { force: true });
  const savedPath = await saveConfig(config);
  console.log("");
  ok(`Saved your setup → ${c.cyan(savedPath)}`);

  for (const s of await install(config, { core: injectedCoreFrom(core.text) })) {
    if (s.status === "manual") {
      console.log(`  ${c.yellow("▸ action needed")} ${c.gray("(" + s.surface + ")")} — ${c.white(s.action)}`);
      for (const line of s.detail.split("\n")) console.log("     " + c.dim(line));
    } else {
      const mark = s.status === "done" ? c.green("✓") : c.gray("–");
      console.log(`  ${mark} ${c.white(s.action)} ${c.gray("(" + s.surface + ")")}`);
    }
  }

  console.log("");
  console.log("  " + c.greenBold("✓ All set."));
  console.log("");
  console.log("  " + c.bold("Next:"));
  console.log("  " + c.cyan("1.") + " Restart your Claude apps so they connect through the server.");
  console.log("  " + c.cyan("2.") + ` Run ${c.bold("agent-julia doctor")} any time to check the connection.`);
  console.log("");
}
