import { z } from "zod";

// Bump this whenever the on-disk shape of config OR the canonical markdown store
// changes in a way that needs a migration. migrations/ holds the ordered steps;
// migrate() brings any older store up to CURRENT_SCHEMA_VERSION on startup.
export const CURRENT_SCHEMA_VERSION = 1;

// The four shipped presets, plus "custom" — a voice you write yourself in
// persona.md, used in place of a preset.
export const STYLE_PRESETS = [
  "sharp-cofounder",
  "calm-mentor",
  "minimalist-engineer",
  "neutral-assistant",
  "custom",
] as const;
export type StylePreset = (typeof STYLE_PRESETS)[number];

export const SEARCH_MODES = ["fts", "semantic", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

// "dispatch" is retained only so older configs still parse; it's no longer an
// offered surface. Dispatch runs on mobile and can't reach the local stdio MCP
// server, so agent-julia supports Claude Code and Cowork (Claude Desktop).
export const SURFACES = ["code", "cowork", "dispatch"] as const;
export type Surface = (typeof SURFACES)[number];

export const WEEKLY_MAINTENANCE = ["cowork-task", "own-routine"] as const;
export type WeeklyMaintenance = (typeof WEEKLY_MAINTENANCE)[number];

// Embedding provider for semantic search. "none" keeps the product fully offline
// and key-free; hybrid/semantic then fall back to FTS-only.
export const EMBEDDING_PROVIDERS = ["none", "local", "openai-compatible"] as const;
export type EmbeddingProviderKind = (typeof EMBEDDING_PROVIDERS)[number];

export const EmbeddingConfigSchema = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS).default("none"),
  // For openai-compatible: base URL + model. API key is read from env, never stored.
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKeyEnv: z.string().default("AGENT_JULIA_EMBED_API_KEY"),
  dims: z.number().int().positive().optional(),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

export const ConfigSchema = z.object({
  schemaVersion: z.number().int().positive().default(CURRENT_SCHEMA_VERSION),

  // Persona identity (the user owns this — defaults describe "Julia").
  name: z.string().min(1).default("Julia"),
  gender: z.enum(["f", "m", "n"]).default("f"),
  pronouns: z.string().default("she/her"),

  // Agent OUTPUT language. Repo/code/docs language is always EN (separate concern).
  language: z.string().default("en"),

  stylePreset: z.enum(STYLE_PRESETS).default("sharp-cofounder"),

  // Canonical markdown store (a git repo the user owns).
  memoryDir: z.string().min(1),

  // Version the memory directory with git and commit after every write. On by
  // default; turn off to keep the store as plain, unversioned markdown.
  git: z.boolean().default(true),

  // Optional git remote (e.g. a private GitHub repo) to back up / sync the store.
  // When set, maintenance pushes to it best-effort. Requires git on.
  gitRemote: z.string().optional(),

  // Push after every write, not just on maintenance. Off by default: immediate
  // off-machine backup at the cost of a network round-trip per write.
  gitAutoPush: z.boolean().default(false),

  search: z.enum(SEARCH_MODES).default("hybrid"),
  embedding: EmbeddingConfigSchema.default({ provider: "none", apiKeyEnv: "AGENT_JULIA_EMBED_API_KEY" }),

  // Max tokens for the persona core injected into context.
  contextBudget: z.number().int().positive().default(1200),

  surfaces: z.array(z.enum(SURFACES)).default(["code", "cowork"]),
  weeklyMaintenance: z.enum(WEEKLY_MAINTENANCE).default("cowork-task"),

  // Categories the agent must never persist. Seeds from sensible privacy defaults.
  privacyHardOff: z.array(z.string()).default([
    "passwords, API keys, tokens, access secrets",
    "card numbers, bank account numbers, IBANs, exact financial amounts",
    "third-party private data without consent",
  ]),
});

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(memoryDir: string): Config {
  return ConfigSchema.parse({ memoryDir, schemaVersion: CURRENT_SCHEMA_VERSION });
}
