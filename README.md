# agent-julia

One brain for your AI — the same memory and persona across Claude Code, Cowork, and Dispatch.

agent-julia is a local-first MCP server that gives your AI assistant a single, persistent memory you own (plain markdown in a git repo) plus a configurable persona (name, gender, language, style). It stays small in the model's context — only a compacted, token-budgeted core is injected — while the full knowledge base lives on disk, indexed for fast full-text and semantic search.

> Status: early development (pre-v0.1). Not yet published.

## Why

- CLAUDE.md and long context are a constant token tax, and models degrade as context grows ("context rot").
- Memory is fragmented across Claude surfaces (Code, Cowork, Dispatch) and trapped per-project.
- agent-julia keeps one clean, owned, versioned memory consistent everywhere, and does its own housekeeping.

## Features (planned v0.1)

- Local-first memory: markdown + git, human-readable, portable, private.
- Fast search: full-text (SQLite FTS5) + semantic (embeddings).
- Persona engine: name / gender / language / style preset, plus learned voice corrections.
- Budgeted context injection to fight context rot.
- Automatic maintenance (re-index, dedupe, compaction) + optional interactive weekly review.
- Zero-friction onboarding wizard that also registers the server with your Claude clients.
- Backward-compatible upgrades with automatic data migrations.

## Configuration

Name and gender are configurable — the default persona is "Julia" (she/her), but you define your own agent's identity, language, and style during setup.

## Install

_TBD — published to npm at v0.1._

## License

MIT
