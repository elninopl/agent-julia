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

## Install

Not yet published to npm. For local development:

```bash
git clone <repo> agent-julia && cd agent-julia
npm install
npm run build
node dist/index.js init      # interactive setup wizard
```

The wizard configures your persona (name, gender, language, style preset — picked
by example) and memory directory, writes a versioned config to
`~/.config/agent-julia/config.json`, initializes the markdown store as a git repo,
and registers the MCP server with the Claude surfaces you choose.

Once published, clients register it as a stdio MCP server:

```jsonc
{
  "mcpServers": {
    "agent-julia": { "command": "npx", "args": ["-y", "agent-julia@latest", "serve"] }
  }
}
```

- **`@latest`** (default): auto-propagates the newest version next session.
- **Pinned** (`agent-julia@0.1.0`): reproducible. Upgrades always ship automatic,
  backup-protected data migrations — no manual file fixing, no data loss.

## Commands

- `agent-julia serve` — start the MCP stdio server (default; used by clients).
- `agent-julia init` — run the setup wizard.
- `agent-julia migrate` — apply pending data migrations and exit.

## MCP tools

`read` · `list` · `search` (FTS + semantic) · `ingest` (schema-enforced write +
git commit) · `correct_voice` · `maintenance` · `get_core` (budgeted persona core).

## Configuration

Name and gender are configurable — the default persona is "Julia" (she/her), but
you define your own agent's identity, language, and style during setup. Embeddings
default to `none` (fully offline, FTS-only) and can be switched to any
OpenAI-compatible provider; the API key is read from the environment, never stored.

## Releasing (maintainers)

CI runs typecheck + build + tests on every PR and push to `main` (Node 20 & 22).
Releases are tag-driven:

```bash
npm version <patch|minor|major>   # bumps package.json + creates the vX.Y.Z tag
git push --follow-tags
```

The `Release` workflow then verifies the tag matches `package.json`, runs the test
suite, publishes to npm via **Trusted Publishing** (OIDC — no stored token), and
creates a GitHub Release using the matching `CHANGELOG.md` section as notes.
Provenance is attached automatically on the OIDC publish.

One-time setup: publish `0.1.0` manually (`npm publish --access public`) to create
the package, then on npmjs.com add a Trusted Publisher for it (GitHub Actions →
repo `agent-julia`, workflow `release.yml`). After that, releases are fully
hands-off. Add the new `CHANGELOG.md` section before tagging.

## License

MIT
