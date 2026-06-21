import { join } from "node:path";
import { homedir } from "node:os";
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
import { ensureGitRepo } from "../store/git.js";
import { allPresets, presetSample } from "../persona/presets.js";
import { composeCore } from "../persona/compose.js";
import { runMaintenance } from "../maintenance/maintenance.js";
import { install } from "./register.js";
import { Prompter } from "./prompt.js";
import { expandPath } from "../util/paths.js";
import { banner, c, hintLine, info, ok, step, summaryBox } from "./ui.js";

const STEPS = 9;

// Pick the language to render style samples in. We ship samples in en + pl; any
// Polish-ish input maps to pl, everything else falls back to en (the samples
// illustrate STYLE, not language).
function sampleLang(language: string): string {
  return /^(pl|pol)/i.test(language.trim()) ? "pl" : "en";
}

// Zero-friction onboarding. Configures the persona by example, writes config with
// schemaVersion, initializes the store (via migrations), builds the index, and
// registers the MCP server with the chosen Claude surfaces.
export async function runWizard(): Promise<void> {
  const p = new Prompter();
  try {
    banner();
    if (configExists()) {
      const overwrite = await p.confirm(
        `A config already exists at ${c.cyan(configPath())}. Reconfigure?`,
        false,
      );
      if (!overwrite) {
        info("Keeping existing config. Nothing changed.");
        return;
      }
    }

    step(1, STEPS, "Agent name");
    const name = await p.text("Name", "Julia");

    step(2, STEPS, "Gender / pronouns");
    const gender = (await p.choice<"f" | "m" | "n">(
      "Pronouns",
      [
        { value: "f", label: "she/her" },
        { value: "m", label: "he/him" },
        { value: "n", label: "they/them" },
      ],
      0,
    )) as Config["gender"];
    const pronouns = gender === "f" ? "she/her" : gender === "m" ? "he/him" : "they/them";

    step(3, STEPS, "Output language");
    hintLine("Any language for the agent's replies — code, docs, and commits stay English.");
    hintLine("Use a code or name, e.g. en · pl · de · es · fr · 'Português'.");
    const language = await p.text("Language", "en");

    step(4, STEPS, "Style — same message, four voices. Pick the one that sounds like your agent.");
    const presets = allPresets();
    const lang = sampleLang(language);
    presets.forEach((preset, i) => {
      console.log(`    ${c.cyanBold(String(i + 1))}  ${c.bold(preset.label)}`);
      console.log(`       ${c.italic(c.gray("“" + presetSample(preset.id, lang) + "”"))}`);
    });
    const stylePreset = await p.choice<StylePreset>(
      "Style preset",
      presets.map((pr) => ({ value: pr.id, label: pr.label })),
      0,
    );

    step(5, STEPS, "Memory directory");
    hintLine("A git repo you own, holding your knowledge base as markdown.");
    hintLine("An existing markdown KB here is adopted, not overwritten.");
    const memoryDirRaw = await p.text("Path", join(homedir(), "agent-julia-memory"));
    const memoryDir = expandPath(memoryDirRaw);

    step(6, STEPS, "Search mode");
    const search = await p.choice<SearchMode>(
      "How recall works",
      [
        {
          value: "hybrid",
          label: "Hybrid — keyword + meaning",
          hint: "Best recall. The semantic half needs an embeddings provider; without one it falls back to keyword-only.",
        },
        {
          value: "fts",
          label: "Full-text — keyword only",
          hint: "Exact keyword match. Fully offline, zero setup, no API or model.",
        },
        {
          value: "semantic",
          label: "Semantic — meaning only",
          hint: "Meaning-based match. Requires an embeddings provider; no keyword fallback.",
        },
      ],
      0,
    );

    let embeddingProvider: EmbeddingProviderKind = "none";
    let embeddingBaseUrl: string | undefined;
    let embeddingModel: string | undefined;
    if (search !== "fts") {
      embeddingProvider = await p.choice<EmbeddingProviderKind>(
        "Embeddings provider",
        [
          {
            value: "none",
            label: "None for now",
            hint: "Stay offline and key-free. Hybrid/semantic act as keyword-only until you set one.",
          },
          {
            value: "openai-compatible",
            label: "OpenAI-compatible API",
            hint: "OpenAI / Ollama / LM Studio. API key read from env, never stored.",
          },
        ],
        0,
      );
      if (embeddingProvider === "openai-compatible") {
        embeddingBaseUrl = await p.text("Embeddings base URL", "https://api.openai.com/v1");
        embeddingModel = await p.text("Embeddings model", "text-embedding-3-small");
        info("Set the API key in env " + c.bold("AGENT_JULIA_EMBED_API_KEY") + " (never stored in config).");
      }
    }

    step(7, STEPS, "Context budget");
    hintLine("Max tokens of persona core injected into the hot path (fights context rot).");
    const contextBudget = Number.parseInt(await p.text("Tokens", "1200"), 10);

    step(8, STEPS, "Surfaces to register");
    const surfaces: Surface[] = [];
    for (const s of [
      { value: "code" as Surface, label: "Claude Code" },
      { value: "cowork" as Surface, label: "Cowork (Claude Desktop)" },
      { value: "dispatch" as Surface, label: "Dispatch (mobile)" },
    ]) {
      if (await p.confirm(`Register with ${s.label}?`, true)) surfaces.push(s.value);
    }

    step(9, STEPS, "Weekly review (owner judgment)");
    const weeklyMaintenance = await p.choice<WeeklyMaintenance>(
      "How to run it",
      [
        {
          value: "cowork-task",
          label: "Cowork scheduled task",
          hint: "A recurring Cowork task runs maintenance and reviews the digest.",
        },
        {
          value: "own-routine",
          label: "Wire into my own routine",
          hint: "Run `agent-julia maintenance` on your own cadence (cron/Todoist).",
        },
      ],
      0,
    );

    const config: Config = ConfigSchema.parse({
      name,
      gender,
      pronouns,
      language,
      stylePreset,
      memoryDir,
      search,
      embedding: {
        provider: embeddingProvider,
        baseUrl: embeddingBaseUrl,
        model: embeddingModel,
        apiKeyEnv: "AGENT_JULIA_EMBED_API_KEY",
      },
      contextBudget: Number.isFinite(contextBudget) ? contextBudget : 1200,
      surfaces,
      weeklyMaintenance,
    });

    summaryBox("Summary", [
      ["persona", `${config.name} (${config.pronouns}) · ${config.language} · ${config.stylePreset}`],
      ["memory", config.memoryDir],
      ["search", `${config.search} · embeddings: ${config.embedding.provider}`],
      ["surfaces", config.surfaces.join(", ") || "(none)"],
    ]);
    if (!(await p.confirm("Write this config and initialize?", true))) {
      info("Aborted. Nothing written.");
      return;
    }

    const savedPath = await saveConfig(config);
    ok(`Config written: ${c.cyan(savedPath)}`);

    // Initialize the store via migrations (creates skeleton + records schemaVersion).
    await migrate(config);
    await ensureGitRepo(config.memoryDir);

    // Adopt an existing markdown knowledge base if one is already there — the
    // maintenance pass below indexes whatever pages exist without clobbering a
    // hand-written index.md (it owns only a managed catalog block).
    const paths = storePaths(config.memoryDir);
    const existing = await listPageIds(paths);
    if (existing.length > 0) {
      ok(`Adopting existing knowledge base: ${c.bold(String(existing.length))} page(s) found.`);
    }

    // Build the index and run a first maintenance pass.
    const indexer = Indexer.open(paths, config);
    await runMaintenance(paths, indexer, config, "auto");
    const core = await composeCore(paths, config);
    indexer.close();
    ok(`Memory initialized at ${c.cyan(config.memoryDir)}`);

    // Register the MCP server AND inject the startup persona core per surface.
    console.log("");
    const steps = await install(config);
    for (const s of steps) {
      const mark = s.status === "done" ? c.green("✓") : s.status === "manual" ? c.yellow("●") : c.gray("–");
      console.log(`  ${mark} ${c.white(s.action)} ${c.gray("(" + s.surface + ")")}`);
      console.log(`     ${c.dim(s.detail)}`);
    }

    // Interactive weekly review (owner judgment) is a v0.2 feature, but the wizard
    // already captured how you want to run it — surface the next step now.
    console.log("\n  " + c.bold("Weekly review") + c.dim(" — contradictions, dedup, promotions"));
    if (config.weeklyMaintenance === "cowork-task") {
      info(
        "Cowork scheduled task: create a weekly task that runs " +
          c.bold("agent-julia maintenance") +
          " and reviews the digest. (Interactive digest lands in v0.2.)",
      );
    } else {
      info(
        "Your own routine: run " +
          c.bold("agent-julia maintenance") +
          " on your cadence (cron/Todoist) and review the flagged items.",
      );
    }

    console.log("");
    console.log(
      `  ${c.greenBold("✓ Done.")} Injected core ~${c.bold(String(core.tokens))}/${core.budget} tokens.`,
    );
    console.log(c.dim("  Restart your Claude clients to pick up the new MCP server.\n"));
  } finally {
    p.close();
  }
}
