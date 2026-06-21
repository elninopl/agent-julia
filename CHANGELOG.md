# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/). MAJOR bumps are reserved for breaking
changes, which always ship an automatic, backup-protected data migration.

## [Unreleased]

## [0.1.0] - 2026-06-21

### Added — v0.1 (initial)

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
- Automatic maintenance: reindex, re-embed on model change, flag orphan links and
  stale-dated facts, refresh `index.md`, recompact the core, git commit.
- Migration framework with `schemaVersion`: ordered, idempotent, backup-protected
  steps run transparently on startup. The derived index is disposable and rebuilt.
- Onboarding wizard (`init`): configures persona + memory and registers the MCP
  server with Claude Code (`~/.claude.json`) and Cowork (Claude Desktop config).
