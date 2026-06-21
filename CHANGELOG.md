# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/). MAJOR bumps are reserved for breaking
changes, which always ship an automatic, backup-protected data migration.

## [Unreleased]

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
