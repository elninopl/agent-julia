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

// What to do about Claude Code's own per-project memory, which does the same
// job as this store and reaches one working directory. "pointer" owns a marked
// block in its index that sends the client here; "absorb" additionally moves
// what was written there anyway into the store. Default is the read-only half:
// moving someone's notes between directories is not a thing to do unasked.
export const CODE_MEMORY_MODES = ["off", "pointer", "absorb"] as const;
export type CodeMemoryMode = (typeof CODE_MEMORY_MODES)[number];

export const WEEKLY_MAINTENANCE = ["cowork-task", "own-routine"] as const;
export type WeeklyMaintenance = (typeof WEEKLY_MAINTENANCE)[number];

// Embedding provider for semantic search. "none" keeps the product fully offline
// and key-free; hybrid/semantic then fall back to FTS-only.
export const EMBEDDING_PROVIDERS = ["none", "local", "openai-compatible"] as const;
export type EmbeddingProviderKind = (typeof EMBEDDING_PROVIDERS)[number];

// Weight precision of a local model. Unset means q8: fp32 of multilingual-e5-base
// holds ~2.8 GB while loaded against ~0.9 GB for q8, and ranks the same pages.
export const LOCAL_DTYPES = ["fp32", "fp16", "q8", "int8", "uint8", "q4"] as const;
export type LocalDtype = (typeof LOCAL_DTYPES)[number];

export const EmbeddingConfigSchema = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS).default("none"),
  // For openai-compatible: base URL + model. API key is read from env, never stored.
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKeyEnv: z.string().default("AGENT_JULIA_EMBED_API_KEY"),
  dims: z.number().int().positive().optional(),
  dtype: z.enum(LOCAL_DTYPES).optional(),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

// A store mounted next to the primary one (memoryDir). Same layout, its own
// index, lock and git; its pages are addressed as `<name>:<page>`. Read-only
// unless `write` is set, so a model can never write into it by accident.
export const STORE_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const ExtraStoreSchema = z.object({
  name: z
    .string()
    .regex(STORE_NAME_RE, "store name: 2-32 characters, lowercase letters, digits and dashes, starting with a letter")
    // Token scopes call the primary store "primary".
    .refine((n) => n !== "primary", 'store name "primary" is reserved for your own store'),
  dir: z.string().min(1),
  write: z.boolean().default(false),
  git: z.boolean().default(true),
  gitRemote: z.string().optional(),
  gitAutoPush: z.boolean().default(false),
});
export type ExtraStore = z.infer<typeof ExtraStoreSchema>;

export const SERVER_AUTH = ["oauth", "bearer", "none"] as const;
export type ServerAuth = (typeof SERVER_AUTH)[number];

// Only read by `serve --http`.
export const ServerConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8787),
  // The URL clients use to reach this server through a reverse proxy, e.g.
  // https://julia.example.com. Required for oauth; with it set, "none" is refused.
  publicUrl: z.string().url().optional(),
  auth: z.enum(SERVER_AUTH).default("none"),
  maintenanceEveryMinutes: z.number().int().positive().default(60),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// Only read by `serve --remote`. The token comes from the environment, never
// from this file.
export const RemoteConfigSchema = z.object({
  url: z.string().url(),
  tokenEnv: z.string().min(1).default("AGENT_JULIA_TOKEN"),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

export const CaptureConfigSchema = z.object({
  hooks: z.boolean().default(false),
  nudgeEveryTurns: z.number().int().positive().default(10),
  extractOnCompact: z.boolean().default(true),
  serverNudge: z.boolean().default(false),
});
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;

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

  // Files outside the Claude ecosystem that carry an exported persona block
  // (e.g. ~/.codex/AGENTS.md). Recorded by `agent-julia export` so the server
  // can keep them refreshed on boot, exactly like the Claude blocks.
  exports: z.array(z.string()).default([]),
  weeklyMaintenance: z.enum(WEEKLY_MAINTENANCE).default("cowork-task"),

  codeMemory: z.enum(CODE_MEMORY_MODES).default("pointer"),

  // Categories the agent must never persist. Seeds from sensible privacy defaults.
  privacyHardOff: z.array(z.string()).default([
    "passwords, API keys, tokens, access secrets",
    "card numbers, bank account numbers, IBANs, exact financial amounts",
    "third-party private data without consent",
  ]),

  // Everything below is optional and has no default, so a config written by an
  // earlier version parses to exactly what it parsed to there and is saved back
  // byte for byte. Read them through the helpers at the end of this file.

  // Read persona.md and voice-corrections.md from this directory instead of
  // memoryDir, and write corrections there. Lets a process whose memory is a
  // shared store keep the persona of a private one.
  personaDir: z.string().min(1).optional(),

  stores: z
    .array(ExtraStoreSchema)
    .superRefine((stores, ctx) => {
      const seen = new Set<string>();
      stores.forEach((s, i) => {
        if (seen.has(s.name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "name"], message: `duplicate store name "${s.name}"` });
        }
        seen.add(s.name);
      });
    })
    .optional(),

  server: ServerConfigSchema.optional(),
  remote: RemoteConfigSchema.optional(),
  capture: CaptureConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function extraStores(cfg: Config): ExtraStore[] {
  return cfg.stores ?? [];
}

export function serverSettings(cfg: Config): ServerConfig {
  return ServerConfigSchema.parse(cfg.server ?? {});
}

export function captureSettings(cfg: Config): CaptureConfig {
  return CaptureConfigSchema.parse(cfg.capture ?? {});
}

export function defaultConfig(memoryDir: string): Config {
  return ConfigSchema.parse({ memoryDir, schemaVersion: CURRENT_SCHEMA_VERSION });
}
