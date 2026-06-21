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
- Fast search: full-text (SQLite FTS5, with stemming) + optional semantic search.
- Semantic search can run **fully local and in-process** (a small multilingual
  model via transformers.js) — no API, no server, no key — or via any
  OpenAI-compatible endpoint. Default stays keyword-only and dependency-light.
- Persona engine: name / gender / language / style preset, plus learned voice corrections.
- Budgeted context injection to fight context rot.
- Automatic maintenance (re-index, dedupe, compaction) + optional interactive weekly review.
- Adopts an existing markdown knowledge base (not just fresh installs).
- Backward-compatible upgrades with automatic data migrations.

## What setup does

The onboarding wizard (`agent-julia init`) does three things, not one. Registering the MCP server alone is not enough — the persona and the "use your memory" instruction must be present in each surface's startup context, because the model reads those before anything else.

1. Registers the MCP server in your Claude clients:
   - Claude Desktop "Local MCP servers" config -> covers Cowork and Dispatch.
   - `~/.claude.json` (user scope) -> covers Claude Code.
2. Injects a small persona + usage core into each surface's startup instructions, inside a managed, clearly marked block (backed up first, idempotent, reversible on uninstall):
   - Claude Code: writes the block into `~/.claude/CLAUDE.md` directly.
   - Cowork: generates the block and guides you to paste it into Settings -> Cowork -> Global instructions (this field is app-stored, not a file), and keeps an on-disk mirror so it can be audited and re-synced.
3. Configures your persona and memory: name, gender, language, style preset (shown by example), memory directory, search mode.

The startup core stays tiny on purpose (persona + "use agent-julia for memory"); everything else lives in your memory base and is pulled in on demand and within a token budget.

## Configuration

Name and gender are configurable — the default persona is "Julia" (she/her), but you define your own agent's identity, language, and style during setup.

## Install

```bash
npx agent-julia init      # interactive setup wizard (persona + memory + client registration)
```

The wizard registers the MCP server with your Claude clients and injects the
persona core. To register it manually as a stdio MCP server:

```jsonc
{
  "mcpServers": {
    "agent-julia": { "command": "npx", "args": ["-y", "agent-julia@latest", "serve"] }
  }
}
```

- `@latest` auto-propagates the newest version next session; pin (`agent-julia@0.1.2`)
  for reproducibility. Upgrades ship automatic, backup-protected data migrations.

## License

MIT
