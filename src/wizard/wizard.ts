import { join } from "node:path";
import { cpus, homedir, totalmem } from "node:os";
import {
  Config,
  ConfigSchema,
  EmbeddingProviderKind,
  SearchMode,
  StylePreset,
  Surface,
  WeeklyMaintenance,
} from "../config/schema.js";
import { configExists, configPath, saveConfig } from "../config/config.js";
import { migrate } from "../migrations/runner.js";
import { Indexer } from "../index/indexer.js";
import { storePaths } from "../store/paths.js";
import { listPageIds } from "../store/markdown.js";
import { ensureGitRepo, setRemoteUrl, verifyRemote } from "../store/git.js";
import { allPresets, presetSample, styleLabel } from "../persona/presets.js";
import { resolveSampleLang } from "../persona/samples.js";
import { seedPersonaTemplate } from "../persona/custom.js";
import {
  checkLocalEmbeddingsAvailable,
  LOCAL_EMBEDDINGS_PACKAGE,
  LOCAL_MODEL_TIERS,
  LocalModelTier,
  recommendLocalTier,
} from "../index/embeddings.js";
import { composeCore } from "../persona/compose.js";
import { runMaintenance } from "../maintenance/maintenance.js";
import { buildInstructions, install } from "./register.js";
import { Prompter } from "./prompt.js";
import { expandPath } from "../util/paths.js";
import { setQuiet } from "../util/log.js";
import { c, examples, info, note, ok, step, summary, welcome } from "./ui.js";

const STEPS = 9;

// Zero-friction onboarding, "guided & warm". Every step explains why it matters,
// recommends a sensible default, and shows concrete examples — then writes the
// config, initializes the store, and wires the agent into your Claude apps.
export async function runWizard(): Promise<void> {
  // The wizard is interactive: without a TTY, readline returns "" on every prompt
  // (EOF) and we'd silently provision a default setup and edit Claude config files.
  if (!process.stdin.isTTY) {
    console.error(
      "agent-julia init needs an interactive terminal. Run it directly, or use `agent-julia sync --print` to see the manual setup.",
    );
    process.exitCode = 1;
    return;
  }
  const p = new Prompter();
  // Keep internal info logs out of the polished wizard flow (warnings/errors stay).
  setQuiet(true);
  try {
    welcome("");
    if (configExists()) {
      console.log("");
      const overwrite = await p.confirm(
        `You already have a setup at ${c.cyan(configPath())}. Start over?`,
        false,
      );
      if (!overwrite) {
        console.log("");
        info("Kept your existing setup. Nothing changed.");
        return;
      }
    }

    // 1 — Name
    step(1, STEPS, "Name", "what your agent calls itself when it talks to you");
    const name = await p.text({ example: "Julia · Max · Ada — anything you like", def: "Julia" });

    // 2 — Pronouns
    step(2, STEPS, "Pronouns", "so the agent refers to itself naturally");
    const gender = await p.choice<"f" | "m" | "n">([
      { value: "f", label: "she / her" },
      { value: "m", label: "he / him" },
      { value: "n", label: "they / them" },
    ]);
    const pronouns = gender === "f" ? "she/her" : gender === "m" ? "he/him" : "they/them";

    // 3 — Language
    step(3, STEPS, "Language", "the language your agent replies in");
    note("Code, docs, and commit messages always stay in English — this is just for conversation.");
    examples("en · pl · de · es · fr · ja — or a name like 'Português'");
    const language = await p.text({ def: "en" });

    // 4 — Style (by example): the SAME message in each voice is the option's desc.
    step(4, STEPS, "Style", "the same message in four voices — pick the one that sounds like your agent");
    const presets = allPresets();
    const resolved = resolveSampleLang(language);
    const lang = resolved ?? "en";
    if (!resolved) {
      note(
        `No samples for '${language}' yet, so these are in English to show the styles. ` +
          `Your agent will still reply in ${language}.`,
      );
    }
    const stylePreset = await p.choice<StylePreset>([
      ...presets.map((pr, i) => ({
        value: pr.id as StylePreset,
        label: pr.label,
        recommended: i === 0,
        desc: "“" + presetSample(pr.id, lang) + "”",
      })),
      {
        value: "custom" as StylePreset,
        label: "Write my own voice",
        desc: "Define your own style in persona.md — used instead of a preset and injected on every surface. Best if you already have a voice you like.",
      },
    ]);

    // 5 — Memory directory
    step(5, STEPS, "Memory", "a folder you own where your knowledge lives, as plain markdown");
    note("It becomes a git repo so nothing is ever lost. Point it at an existing markdown KB and it's adopted, not overwritten.");
    const memoryDirRaw = await p.text({
      example: "~/agent-julia-memory or an existing notes folder",
      def: join(homedir(), "agent-julia-memory"),
    });
    const memoryDir = expandPath(memoryDirRaw);
    console.log("");
    const useGit = await p.confirm(
      "Version it with git? Every change is committed, so nothing is lost and you can roll back.",
      true,
    );
    let gitRemote: string | undefined;
    if (useGit) {
      note("Optional remote (e.g. a private GitHub repo) to back up your memory off-machine. Create the empty repo first, paste its URL, or leave blank to skip.");
      const r = (await p.text({ example: "git@github.com:you/agent-julia-memory.git" })).trim();
      if (r) gitRemote = r;
    }
    let gitAutoPush = false;
    if (gitRemote) {
      console.log("");
      gitAutoPush = await p.confirm(
        "Push after every change? (Yes = immediate off-machine backup; No = sync on maintenance.)",
        false,
      );
    }

    // 6 — Search
    step(6, STEPS, "Search", "how your agent finds things in its memory");
    const search = await p.choice<SearchMode>([
      {
        value: "hybrid",
        label: "Smart — keywords + meaning",
        recommended: true,
        desc: "Finds the right note even when you word it differently. The 'meaning' half uses an embeddings provider (next question); until you add one, it quietly works on keywords.",
      },
      {
        value: "fts",
        label: "Keywords only",
        desc: "Matches the exact words you type. Fully offline, nothing to set up, no account or model.",
      },
      {
        value: "semantic",
        label: "Meaning only",
        desc: "Understands what you mean even with different words — but needs an embeddings provider, and won't match exact words on its own.",
      },
    ]);

    // 6b — Embeddings provider (only when meaning is involved)
    let embeddingProvider: EmbeddingProviderKind = "none";
    let embeddingBaseUrl: string | undefined;
    let embeddingModel: string | undefined;
    let embeddingDims: number | undefined;
    if (search !== "fts") {
      console.log("");
      info("Search-by-meaning needs something to turn text into vectors:");
      embeddingProvider = await p.choice<EmbeddingProviderKind>([
        {
          value: "local",
          label: "Local model — fully offline, no API",
          recommended: true,
          desc: "Runs a small multilingual model right here, no server or key. One extra package + a ~120 MB model download on first use; then it's private and free.",
        },
        {
          value: "none",
          label: "Not now — keywords only",
          desc: "Stay lean and offline. Search matches keywords until you pick a model later (re-run setup any time).",
        },
        {
          value: "openai-compatible",
          label: "Hosted / external API",
          desc: "OpenAI, or a local server like Ollama / LM Studio. Your API key is read from an environment variable, never written to disk.",
        },
      ]);
      if (embeddingProvider === "local") {
        const ramGB = Math.round(totalmem() / 2 ** 30);
        const cores = cpus().length;
        const rec = recommendLocalTier(ramGB, cores);
        info(
          `Each model is a one-time download cached on disk, and loads into RAM (~the download size plus a little) ` +
            `while search runs. This machine has ~${ramGB} GB RAM and ${cores} CPU cores — RAM fits any tier easily, ` +
            `so the suggestion leans on cores, since a bigger model is mainly slower per query on the CPU.`,
        );
        const tier = await p.choice<LocalModelTier>([
          {
            value: "small",
            label: `Small — fast & light (${LOCAL_MODEL_TIERS.small.disk} disk, ${LOCAL_MODEL_TIERS.small.ram} RAM)`,
            recommended: rec === "small",
            desc: "multilingual-e5-small, 384 dims. Quick on any machine, ~118 languages. The safe default.",
          },
          {
            value: "base",
            label: `Base — better quality (${LOCAL_MODEL_TIERS.base.disk} disk, ${LOCAL_MODEL_TIERS.base.ram} RAM)`,
            recommended: rec === "base",
            desc: "multilingual-e5-base, 768 dims. Noticeably stronger recall; bigger download, a bit slower.",
          },
          {
            value: "large",
            label: `Best — highest quality (${LOCAL_MODEL_TIERS.large.disk} disk, ${LOCAL_MODEL_TIERS.large.ram} RAM)`,
            desc: "multilingual-e5-large, 1024 dims. Top quality; largest download and slowest per query.",
          },
        ]);
        embeddingModel = LOCAL_MODEL_TIERS[tier].model;
        embeddingDims = LOCAL_MODEL_TIERS[tier].dims;

        const available = await checkLocalEmbeddingsAvailable();
        if (available) {
          ok("Local model package is installed. The model downloads on first search.");
        } else {
          note(`One-time install needed for the local model — run:  npm i -g ${LOCAL_EMBEDDINGS_PACKAGE}`);
          note("Until it's installed, search runs on keywords. Everything else works now.");
        }
      }
      if (embeddingProvider === "openai-compatible") {
        embeddingBaseUrl = await p.text({ example: "https://api.openai.com/v1", def: "https://api.openai.com/v1" });
        embeddingModel = await p.text({ example: "text-embedding-3-small", def: "text-embedding-3-small" });
        note("Set your key in the env var AGENT_JULIA_EMBED_API_KEY before starting the server. It's never stored in config.");
      }
    }

    // 7 — Context budget
    step(7, STEPS, "Persona budget", "how much of your agent's personality rides in every message");
    note("Identity and voice rules travel with each turn so the agent stays in character. Bigger = more personality up front, slightly more cost per message. Everything else in your memory is fetched only when needed.");
    const budgetPick = await p.choice<string>([
      { value: "800", label: "Lean — about 800 tokens", desc: "Name, language, and the core rules. Lowest overhead." },
      {
        value: "1200",
        label: "Balanced — about 1200 tokens",
        recommended: true,
        desc: "Full voice rules plus your saved corrections. Small and complete — the right call for almost everyone.",
      },
      { value: "2000", label: "Rich — about 2000 tokens", desc: "Extra headroom as your voice corrections grow over time." },
      { value: "custom", label: "Custom…", desc: "Type your own number of tokens." },
    ]);
    let contextBudget = 1200;
    if (budgetPick === "custom") {
      const typed = Number.parseInt(await p.text({ example: "1500", def: "1200" }), 10);
      const wanted = Number.isFinite(typed) ? typed : 1200;
      // Keep it sane: too small truncates the persona to nothing; too large
      // defeats the point of a budgeted core.
      contextBudget = Math.min(8000, Math.max(400, wanted));
      if (contextBudget !== wanted) note(`Using ${contextBudget} tokens (kept within 400–8000).`);
    } else {
      contextBudget = Number.parseInt(budgetPick, 10);
    }

    // 8 — Surfaces
    step(8, STEPS, "Where to use it", "register your agent with your Claude apps");
    note("Same memory and persona everywhere. You can add or remove surfaces later with `agent-julia sync`.");
    console.log("");
    const surfaces: Surface[] = [];
    if (await p.confirm("Claude Code (the terminal CLI)?", true)) surfaces.push("code");
    if (await p.confirm("Claude Desktop (Cowork)?", true)) surfaces.push("cowork");

    // 9 — Weekly review
    step(9, STEPS, "Weekly review", "a human-judgment pass — contradictions, duplicates, what to promote");
    const weeklyMaintenance = await p.choice<WeeklyMaintenance>([
      {
        value: "cowork-task",
        label: "Let Cowork run it on a schedule",
        recommended: true,
        desc: "A recurring Cowork task runs maintenance and shows you a digest to approve.",
      },
      {
        value: "own-routine",
        label: "I'll run it myself",
        desc: "Run `agent-julia maintenance` on your own cadence (cron, a Todoist reminder, whatever fits).",
      },
    ]);

    const config: Config = ConfigSchema.parse({
      name,
      gender,
      pronouns,
      language,
      stylePreset,
      memoryDir,
      git: useGit,
      gitRemote,
      gitAutoPush,
      search,
      embedding: {
        provider: embeddingProvider,
        baseUrl: embeddingBaseUrl,
        model: embeddingModel,
        dims: embeddingDims,
        apiKeyEnv: "AGENT_JULIA_EMBED_API_KEY",
      },
      contextBudget,
      surfaces,
      weeklyMaintenance,
    });

    // How to apply the changes to your Claude apps: do it for you, or print the
    // exact edits to make by hand.
    console.log("");
    const applyAuto = await p.confirm(
      "Set up your Claude apps for you? (No = print the exact changes to make.) Your memory and config are created either way.",
      true,
    );

    summary("Here's your setup", [
      ["agent", `${config.name} · ${config.pronouns} · speaks ${config.language}`],
      ["style", styleLabel(config.stylePreset)],
      ["memory", `${config.memoryDir}${config.git ? " (git)" : " (no git)"}${config.gitRemote ? ` → ${config.gitRemote}${config.gitAutoPush ? " (auto-push)" : ""}` : ""}`],
      ["search", config.search === "fts" ? "keywords only" : `${config.search} · provider: ${config.embedding.provider}`],
      ["budget", `~${config.contextBudget} tokens`],
      ["surfaces", `${surfacesLabel(config.surfaces)} · ${applyAuto ? "auto setup" : "manual setup"}`],
    ]);
    console.log("");
    if (!(await p.confirm("Looks good — create it?", true))) {
      console.log("");
      info("No problem. Nothing was written.");
      return;
    }

    const savedPath = await saveConfig(config);
    console.log("");
    ok(`Saved your setup → ${c.cyan(savedPath)}`);

    // Initialize the store via migrations (creates skeleton + records schemaVersion).
    await migrate(config);
    if (config.git) await ensureGitRepo(config.memoryDir);
    if (config.git && config.gitRemote) {
      await setRemoteUrl(config.memoryDir, config.gitRemote);
      const check = await verifyRemote(config.memoryDir);
      if (check.ok) {
        ok(`Remote backup set + reachable → ${c.cyan(config.gitRemote)}`);
      } else {
        note(
          `Remote set to ${config.gitRemote}, but it's not reachable yet (${check.error}). ` +
            "Fix access (create the repo / check credentials), then run `agent-julia push`. " +
            "Until it's reachable, your memory stays local-only.",
        );
      }
    }

    // Adopt an existing markdown knowledge base if one is already there.
    const paths = storePaths(config.memoryDir);
    const existing = await listPageIds(paths);
    if (existing.length > 0) {
      ok(`Adopted your existing knowledge base — ${c.bold(String(existing.length))} page(s).`);
    }

    // A custom voice needs a persona.md to live in — seed a template to edit.
    if (config.stylePreset === "custom") {
      await seedPersonaTemplate(paths);
      console.log("");
      console.log("  " + c.bold("Your custom voice:"));
      console.log("    " + c.cyan(paths.personaFile));
      console.log("    " + c.dim("It's a starter template now. Write your voice in that file,"));
      console.log("    " + c.dim("then run `agent-julia sync` to apply it on every surface."));
    }

    const indexer = Indexer.open(paths, config);
    await runMaintenance(paths, indexer, config, "auto");
    const core = await composeCore(paths, config);
    indexer.close();
    ok(`Memory ready at ${c.cyan(config.memoryDir)}`);

    // Register the MCP server and inject the persona core — or print the steps.
    if (applyAuto) {
      const steps = await install(config);
      for (const s of steps) {
        if (s.status === "manual") {
          console.log(`  ${c.yellow("▸ action needed")} ${c.gray("(" + s.surface + ")")} — ${c.white(s.action)}`);
          for (const line of s.detail.split("\n")) console.log("     " + c.dim(line));
        } else {
          const mark = s.status === "done" ? c.green("✓") : c.gray("–");
          console.log(`  ${mark} ${c.white(s.action)} ${c.gray("(" + s.surface + ")")}`);
        }
      }
    } else {
      console.log("");
      console.log("  " + c.bold("Add these to your Claude apps yourself:"));
      console.log("");
      console.log((await buildInstructions(config)).replace(/^/gm, "  "));
    }

    // Closing: clear, encouraging next steps — only the ones that apply.
    const wantDesktop = config.surfaces.includes("cowork") || config.surfaces.includes("dispatch");
    const next: string[] = [];
    if (config.stylePreset === "custom") {
      next.push(`Write your voice in ${c.bold("persona.md")}, then run ${c.bold("agent-julia sync")} to apply it.`);
    }
    if (applyAuto && wantDesktop) {
      next.push("Finish the Cowork paste shown above (it's on your clipboard) so Cowork picks up the persona.");
    }
    next.push("Restart your Claude apps so they pick up the new MCP server.");
    next.push(`Say hi — your agent is now ${c.bold(config.name)}, with memory that follows you.`);
    next.push(
      config.weeklyMaintenance === "cowork-task"
        ? `Set up a weekly Cowork task running ${c.bold("agent-julia maintenance")}.`
        : `Run ${c.bold("agent-julia maintenance")} weekly (cron/Todoist) for housekeeping.`,
    );

    console.log("");
    console.log("  " + c.greenBold("✓ All set.") + c.dim(`  Persona core is ~${core.tokens}/${core.budget} tokens.`));
    console.log("");
    console.log("  " + c.bold("Next:"));
    next.forEach((line, i) => console.log("  " + c.cyan(`${i + 1}.`) + " " + line));
    console.log("");
  } finally {
    p.close();
  }
}

function surfacesLabel(surfaces: Surface[]): string {
  const parts: string[] = [];
  if (surfaces.includes("code")) parts.push("Claude Code");
  if (surfaces.includes("cowork") || surfaces.includes("dispatch")) parts.push("Claude Desktop (Cowork)");
  return parts.join(" · ") || "(none)";
}
