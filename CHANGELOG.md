# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/). MAJOR bumps are reserved for breaking
changes, which always ship an automatic, backup-protected data migration.

## [Unreleased]

## [0.1.4] - 2026-06-21

### Added

- Diacritics-insensitive keyword search: `cafe` matches `café`, `krakow` matches
  `Kraków`. Covers accented letters across European languages.
- CJK and Thai search: for languages written without spaces, the index uses a
  trigram tokenizer so substring search works. The tokenizer is chosen from your
  configured language.
- Local embedding model sizes — small, base, or large (the `multilingual-e5`
  family) — selectable in the wizard, trading download size for quality.
- Per-page language is detected automatically and recorded in frontmatter.

### Changed

- Documentation rewritten; README expanded with architecture, search, persona,
  configuration, and a full tool and command reference.

## [0.1.3] - 2026-06-21

### Added

- Local, in-process semantic search — no API, no server, no key. Optional
  `local` embeddings provider runs `multilingual-e5-small` (384d, ~118 languages)
  via transformers.js; cross-lingual (a Polish query finds an English note). The
  model package is an optional peer dependency (lazy-loaded), so the base install
  stays tiny; the wizard offers it and guides the one-time install.
- FTS now uses a Porter stemming tokenizer, so different word forms match
  (`debug` ↔ `debugging`). The index auto-rebuilds on this tokenizer change.
- Incremental index sync: pages are reindexed by content hash, so hand-edits to
  the markdown (outside `ingest`) are detected, new pages added, deleted pages
  dropped — without re-embedding unchanged pages (no needless embedding-API calls).
- Automatic maintenance now also runs on server startup (the "cron" half of
  on-write + cron): non-fatal, incremental, picks up out-of-band edits and flags.
- Wizard surfaces the next step for the chosen weekly-review mode (Cowork task vs
  own routine).

### Changed

- Wizard redesigned ("guided & warm"): warm intro, per-step "why it matters"
  explanation, plain-language option descriptions, recommendations, concrete
  examples, framed recap, and an encouraging next-steps closing. Colorized;
  auto-disables on non-TTY / `NO_COLOR` (and `FORCE_COLOR=1` forces it on).
- Style samples now ship in the 20 most widely used languages; for any other
  language the wizard shows English samples with a clear note that they only
  illustrate STYLE — the agent still replies in the chosen language.
- Language is free-form (any code or name), not a two-option pick.
- Search and embeddings-provider choices explained in plain language (offline vs
  needs provider, keywords vs meaning, fallback behavior).
- Persona (context) budget is now a pick of Lean / Balanced (recommended) / Rich
  with token examples, plus a Custom option — no more bare number prompt.
- Internal info logs are silenced during the wizard so its output stays clean.

## [0.1.2] - 2026-06-21

### Changed

- README install instructions reflect the now-published npm package
  (`npm i agent-julia`, MCP registration snippet).

### Fixed

- Add `repository` field to `package.json`, required for npm provenance
  verification on the OIDC trusted-publishing pipeline (0.1.1 failed to publish
  without it).

## [0.1.0] - 2026-06-21

First public release.

### Added

- Local-first memory store: markdown + git as the canonical source of truth
  (`index.md` catalog, append-only `log.md`, `pages/`, `archive/`).
- MCP stdio server with tools: `read`, `list`, `search`, `ingest`,
  `correct_voice`, `maintenance`, `get_core`; plus a `persona-core` resource.
- Search: SQLite FTS5 full-text + pluggable embeddings (default `none`, fully
  offline; optional OpenAI-compatible provider). Hybrid mode fuses both and
  degrades to FTS when no embedding provider is configured.
- Persona engine: 3 layers with explicit precedence — L3 user voice corrections >
  L1 universal core > L2 style preset (4 presets, picked by example in the wizard).
- Budgeted core injection: only a compacted, token-budgeted core hits the hot path.
- Setup injects a small persona + "use your memory" core into each surface's
  startup context (not just MCP registration): a managed, marked, backed-up,
  reversible block in `~/.claude/CLAUDE.md` (Code) and an on-disk mirror for Cowork
  Global instructions (covers Dispatch). Desktop config covers Cowork + Dispatch;
  `~/.claude.json` covers Claude Code.
- Adopts an existing markdown knowledge base: existing pages are indexed and a
  hand-written `index.md` is never clobbered (only a managed catalog block is owned).
- Automatic maintenance: reindex, re-embed on model change, flag orphan links and
  stale-dated facts, refresh `index.md`, recompact the core, git commit.
- Migration framework with `schemaVersion`: ordered, idempotent, backup-protected
  steps run transparently on startup. The derived index is disposable and rebuilt.
- Onboarding wizard (`init`) plus `sync` and `uninstall` commands.
