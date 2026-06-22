# agent-julia

**One brain for your AI.** A memory and persona that stay the same across Claude Code, Claude Desktop (Cowork), and Dispatch — owned by you, stored as plain markdown in a git repo, and kept small in the model's context.

[![npm](https://img.shields.io/npm/v/agent-julia.svg)](https://www.npmjs.com/package/agent-julia)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

```bash
npx agent-julia init
```

---

## The problem

Every Claude surface remembers you differently. Claude Code reads `~/.claude/CLAUDE.md` and a project file. Claude Desktop has its own global instructions. Mobile Dispatch has another store again. They drift. The same person ends up with a different assistant on every device, and a durable fact written in one place never reaches the others.

At the same time, anything you put in those startup files is a tax. It loads before every turn, in every session, and long context measurably degrades output — the model gets worse as the window fills, well before it's full.

agent-julia fixes both. Your knowledge lives in one markdown repository you own. Only a small, budgeted slice of it — the persona and a "use your memory" instruction — is injected into each surface's startup context. Everything else is pulled on demand through search, and never weighs down the conversation.

## How it works

- **Canonical store** — plain markdown in a git repo. Human-readable, portable, versioned, private. This is the source of truth, not a database.
- **Derived index** — SQLite (FTS5 full-text + optional vector embeddings) built from the markdown. It's disposable: delete it and it rebuilds itself from your files.
- **Budgeted core** — a compact persona block is injected into Claude Code's `CLAUDE.md` and Claude Desktop's global instructions. It stays within a token budget you set, so it never crowds out the conversation.
- **One MCP server** — every surface talks to the same `agent-julia` server over stdio, so they share one memory and one persona.

## Quick start

```bash
npx agent-julia init
```

There's no separate install step: `npx` fetches agent-julia into its own cache and runs the setup in one go (the first run also builds the native SQLite binding, so it takes a little longer). Nothing is added to a project or installed globally — run `npm i -g agent-julia` only if you'd rather keep it installed permanently. The MCP server is launched the same way (`npx -y agent-julia@latest serve`), so it stays current automatically.

The setup wizard walks you through your agent's name, pronouns, language, and voice; picks where your memory lives and whether to version it with git; configures search; and registers the server with the Claude apps you use. It can write a small persona block into each app's startup context — or print the exact changes for you to make by hand. When it does it for you, each file is backed up first, written inside a marked block, and fully reversible.

When you're done, restart your Claude apps so they pick up the new MCP server.

To register the server by hand instead:

```jsonc
{
  "mcpServers": {
    "agent-julia": { "command": "npx", "args": ["-y", "agent-julia@latest", "serve"] }
  }
}
```

`@latest` picks up new versions automatically next session; pin a version (e.g. `agent-julia@0.1.6`) if you want it fixed. Either way, upgrades run automatic, backup-protected migrations — they never lose data or ask you to hand-edit files.

## Manual setup

The wizard can write the Claude config changes for you, or print the exact edits so you make them yourself — it asks which you prefer, and never touches a Claude file without that choice. To see the steps any time:

```bash
agent-julia sync --print
```

What it adds:

**Claude Code** — in `~/.claude.json`, add the server under `mcpServers`:

```jsonc
{ "mcpServers": { "agent-julia": { "command": "npx", "args": ["-y", "agent-julia@latest", "serve"] } } }
```

Then append the persona block (printed by the command) to `~/.claude/CLAUDE.md`.

**Claude Desktop (covers Cowork and Dispatch)** — add the same `mcpServers` entry to the Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS), and paste the persona block into **Settings → Cowork → Global instructions**. Dispatch shares the desktop account, so it's covered too.

The persona block is small on purpose — identity plus an instruction to use agent-julia for memory. Everything else is fetched on demand. When the wizard does this for you, it backs up each file first, writes inside a marked block, and `agent-julia uninstall` removes it cleanly.

## Search

Two layers work together, and both run locally.

**Keyword (always on).** SQLite FTS5 with Porter stemming, so `debug` matches `debugging`, and diacritics folding, so `cafe` matches `café` and `krakow` matches `Kraków`. For languages without spaces between words — Chinese, Japanese, Korean, Thai — agent-julia switches to a trigram tokenizer so substring search still works. The tokenizer is chosen from your configured language.

**Meaning (optional).** Turn on semantic search to find a note even when you phrase it differently, and across languages — a question in Polish can surface an English note. You choose how it runs:

- **Local model** — a multilingual model (the `multilingual-e5` family, ~118 languages) runs in-process. No server, no API key, fully offline after a one-time model download. Pick a size in the wizard: small (~120 MB download, ~0.3 GB RAM), base (~280 MB, ~0.6 GB), or large (~560 MB, ~1.3 GB). The size is a one-time download cached on disk; the model also loads into RAM while search runs. The wizard reads your machine's RAM and CPU cores and suggests a tier. RAM is rarely the limit — even the largest model needs only ~1.3 GB — so the suggestion leans on cores, since a bigger model's main cost is slower CPU inference per query. The real trade-off is download size and speed against quality. Needs one extra package, `@huggingface/transformers`, which stays optional so the base install is tiny.
- **Hosted API** — any OpenAI-compatible endpoint (OpenAI, or a local server like Ollama or LM Studio). Your key is read from an environment variable and never written to disk.
- **None** — stay keyword-only. The default, and completely dependency-free.

Hybrid mode blends keyword and meaning, and degrades gracefully: with no embeddings configured, it's simply keyword search.

## Persona

The persona has three layers, with a clear order when they disagree:

1. **User corrections** (highest) — short notes you record over time, like "don't use the word X" or "less hedging". Captured with the `correct_voice` tool, kept in `voice-corrections.md`, and applied above everything else. It's your agent.
2. **Universal core** — a small set of communication rules that apply to every persona: talk like a person, lead with a recommendation, skip filler.
3. **Style** (lowest) — either one of four shipped voices (sharp co-founder, calm mentor, minimalist engineer, neutral assistant) or your **own voice**. For the presets, the wizard shows the *same* message in all four, in your language, so you choose by ear. For a custom voice, pick "Write my own voice" and describe how the agent should speak in `persona.md`; it's used in place of a preset.

The composed persona core — identity, universal core, your style or custom voice, and corrections — is injected into each surface's startup context within your token budget, so the agent is always in character without fetching anything. (The `get_core` tool returns the same core on demand.)

Name, pronouns, and language are yours to set. The default persona is "Julia" (she/her), but you define your own.

## Memory model

Your store follows a simple, enforced layout:

```
your-memory/
  index.md     catalog of pages (kept current automatically)
  log.md       append-only journal of changes
  pages/       one page per topic, kebab-case
  archive/     retired pages, read-only
```

Pages carry light frontmatter — title, status, last-updated date, and an auto-detected language — and link to each other with `[[wiki-links]]`. Writing always goes through the `ingest` tool, which updates the page, refreshes the catalog, appends the journal, reindexes, and commits to git in one step.

Point the wizard at an existing markdown knowledge base and agent-julia adopts it: your pages are indexed and a hand-written `index.md` is left alone — agent-julia only manages a clearly marked block inside it.

Optionally back the store with a git remote — a private GitHub repo, say — set in the wizard or later with `agent-julia remote <url>`. By default it syncs on maintenance (and server startup), best-effort, so an offline moment or a missing credential never blocks a write; it just pushes on the next run. Turn on `gitAutoPush` to push after every write instead, trading a network round-trip per write for immediate off-machine backup. `agent-julia push` syncs on demand.

## MCP tools

| Tool | What it does |
| --- | --- |
| `search` | Find pages by keyword and meaning |
| `read` | Read a page in full |
| `list` | List every page with title, status, and date |
| `ingest` | Create or update a page (schema-enforced, git-committed) |
| `correct_voice` | Record a voice correction |
| `get_core` | Return the budgeted persona core |
| `maintenance` | Reindex, flag stale notes and broken links, recompact, commit |

The persona core is also exposed as a resource (`agent-julia://core`) for clients that prefer resources to a tool call.

## Commands

| Command | |
| --- | --- |
| `agent-julia serve` | Start the MCP server (default; used by the Claude apps) |
| `agent-julia init` | Run the setup wizard |
| `agent-julia sync` | Re-apply registration and the persona block for the current config |
| `agent-julia uninstall` | Remove the managed blocks and registration (backups are kept) |
| `agent-julia remote [url]` | Show or set a git remote to back up your memory |
| `agent-julia push` | Push the memory store to its remote now |
| `agent-julia migrate` | Apply pending data migrations and exit |

## Configuration

Settings live in `~/.config/agent-julia/config.json` and carry a `schemaVersion`. The wizard writes it for you; the fields:

| Field | Meaning |
| --- | --- |
| `name`, `gender`, `pronouns` | Persona identity |
| `language` | The agent's reply language (any code or name) |
| `stylePreset` | One of the four voices |
| `memoryDir` | Your markdown store |
| `git` | Version the store with git and commit after every write (default on) |
| `gitRemote` | Optional git remote (e.g. a private GitHub repo) to back up / sync the store |
| `gitAutoPush` | Push after every write, not just on maintenance (default off) |
| `search` | `hybrid`, `fts`, or `semantic` |
| `embedding` | Provider (`none`, `local`, `openai-compatible`), model, and dimensions |
| `contextBudget` | Token ceiling for the injected persona core |
| `surfaces` | Which Claude apps to register |
| `privacyHardOff` | Categories the agent must never store (keys, card numbers, third-party private data) |

## Maintenance

Housekeeping runs on its own. On every write, and again when the server starts, agent-julia reindexes changed pages, picks up files you edited by hand, flags stale-dated notes and broken links, refreshes the catalog, recompacts the persona core, and commits. Nothing is deleted without you — stale items are flagged, not removed.

A heavier weekly pass — for contradictions, duplicates, and deciding what to promote — is owner's-judgment work. Run `agent-julia maintenance` on whatever cadence suits you, or schedule it as a Claude Desktop task.

## Upgrades

Releases are backward-compatible, or they ship an automatic migration that runs on first launch — backed up, idempotent, and transparent. The config carries a `schemaVersion`; ordered migration steps bring older stores forward on startup. The derived search index is disposable and simply rebuilds itself when its shape changes. Upgrades never lose data and never ask you to fix files by hand.

## Releasing (maintainers)

CI runs typecheck, build, and tests on every pull request and push to `main` (Node 20 and 22). Releases are tag-driven:

```bash
# add the new section to CHANGELOG.md, then:
npm version <patch|minor|major>
git push --follow-tags
```

A `vX.Y.Z` tag triggers the release workflow: it checks the tag against `package.json`, runs the tests, publishes to npm via Trusted Publishing (OIDC — no stored token, provenance attached automatically), and cuts a GitHub release from the matching CHANGELOG section.

## Credits

The persona's "avoid the tells of AI writing" rules are adapted from the
[humanizer](https://github.com/blader/humanizer) skill by Siqi Chen (MIT),
itself based on Wikipedia's "Signs of AI writing" (WikiProject AI Cleanup,
CC BY-SA).

## License

MIT.
