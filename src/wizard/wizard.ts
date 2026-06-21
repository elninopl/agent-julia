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
import { ensureGitRepo } from "../store/git.js";
import { allPresets, presetSample } from "../persona/presets.js";
import { composeCore } from "../persona/compose.js";
import { runMaintenance } from "../maintenance/maintenance.js";
import { registerSurfaces } from "./register.js";
import { Prompter } from "./prompt.js";
import { expandPath } from "../util/paths.js";

// Zero-friction onboarding. Configures the persona by example, writes config with
// schemaVersion, initializes the store (via migrations), builds the index, and
// registers the MCP server with the chosen Claude surfaces.
export async function runWizard(): Promise<void> {
  const p = new Prompter();
  try {
    console.log("\nagent-julia — setup\n===================");
    if (configExists()) {
      const overwrite = await p.confirm(
        `A config already exists at ${configPath()}. Reconfigure?`,
        false,
      );
      if (!overwrite) {
        console.log("Keeping existing config. Nothing changed.");
        return;
      }
    }

    const name = await p.text("Agent name", "Julia");
    const gender = (await p.choice<"f" | "m" | "n">(
      "Gender / pronouns",
      [
        { value: "f", label: "she/her" },
        { value: "m", label: "he/him" },
        { value: "n", label: "they/them" },
      ],
      0,
    )) as Config["gender"];
    const pronouns = gender === "f" ? "she/her" : gender === "m" ? "he/him" : "they/them";

    const language = await p.choice(
      "Output language (code & docs stay English)",
      [
        { value: "en", label: "English" },
        { value: "pl", label: "Polski" },
      ],
      0,
    );

    // Style preset BY EXAMPLE — show the same utterance in all four voices.
    console.log("\nSame message, four voices — pick the one that sounds like your agent:\n");
    const presets = allPresets();
    presets.forEach((preset, i) => {
      console.log(`  ${i + 1}) ${preset.label}`);
      console.log(`     “${presetSample(preset.id, language)}”\n`);
    });
    const stylePreset = await p.choice<StylePreset>(
      "Style preset",
      presets.map((pr) => ({ value: pr.id, label: pr.label })),
      0,
    );

    const memoryDirRaw = await p.text(
      "Memory directory (git repo you own)",
      join(homedir(), "agent-julia-memory"),
    );
    const memoryDir = expandPath(memoryDirRaw);

    const search = await p.choice<SearchMode>(
      "Search mode",
      [
        { value: "hybrid", label: "Hybrid (FTS + embeddings) — recommended" },
        { value: "fts", label: "Full-text only (offline, no embeddings)" },
        { value: "semantic", label: "Semantic only" },
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
          { value: "none", label: "None for now (FTS-only until configured) — privacy-first default" },
          { value: "openai-compatible", label: "OpenAI-compatible API (OpenAI / Ollama / LM Studio)" },
        ],
        0,
      );
      if (embeddingProvider === "openai-compatible") {
        embeddingBaseUrl = await p.text("Embeddings base URL", "https://api.openai.com/v1");
        embeddingModel = await p.text("Embeddings model", "text-embedding-3-small");
        console.log(
          "  Set the API key in env AGENT_JULIA_EMBED_API_KEY (never stored in config).",
        );
      }
    }

    const contextBudget = Number.parseInt(
      await p.text("Context budget for the injected core (tokens)", "1200"),
      10,
    );

    const surfaces: Surface[] = [];
    for (const s of [
      { value: "code" as Surface, label: "Claude Code" },
      { value: "cowork" as Surface, label: "Cowork (Claude Desktop)" },
      { value: "dispatch" as Surface, label: "Dispatch (mobile)" },
    ]) {
      if (await p.confirm(`Register with ${s.label}?`, true)) surfaces.push(s.value);
    }

    const weeklyMaintenance = await p.choice<WeeklyMaintenance>(
      "Interactive weekly review (owner judgment)",
      [
        { value: "cowork-task", label: "Cowork scheduled task (recommended)" },
        { value: "own-routine", label: "Wire into my own routine" },
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

    console.log("\nSummary:");
    console.log(`  ${config.name} (${config.pronouns}), ${config.language}, ${config.stylePreset}`);
    console.log(`  memory: ${config.memoryDir}`);
    console.log(`  search: ${config.search} / embeddings: ${config.embedding.provider}`);
    console.log(`  surfaces: ${config.surfaces.join(", ") || "(none)"}`);
    if (!(await p.confirm("\nWrite this config and initialize?", true))) {
      console.log("Aborted. Nothing written.");
      return;
    }

    const savedPath = await saveConfig(config);
    console.log(`\nConfig written: ${savedPath}`);

    // Initialize the store via migrations (creates skeleton + records schemaVersion).
    await migrate(config);
    await ensureGitRepo(config.memoryDir);

    // Build the index and run a first maintenance pass.
    const paths = storePaths(config.memoryDir);
    const indexer = Indexer.open(paths, config);
    await runMaintenance(paths, indexer, config, "auto");
    const core = await composeCore(paths, config);
    indexer.close();

    // Register the MCP server with the chosen surfaces.
    const reg = await registerSurfaces(config.surfaces);
    console.log("\nClient registration:");
    for (const r of reg) console.log(`  ${r.surface}: ${r.status} — ${r.detail}`);

    console.log(
      `\nDone. Injected core is ~${core.tokens}/${core.budget} tokens.` +
        `\nRestart your Claude clients to pick up the new MCP server.`,
    );
  } finally {
    p.close();
  }
}
