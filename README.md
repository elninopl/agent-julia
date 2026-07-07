<p align="center">
  <img src="https://raw.githubusercontent.com/elninopl/agent-julia/main/scripts/AgentJulia.png" alt="Agent Julia — one brain for Claude Code and Claude Cowork" width="540">
</p>

# Agent Julia

**One brain for your AI.** A memory and persona that stay the same across Claude Code and Claude Desktop (Cowork) — owned by you, stored as plain markdown in a git repo, and kept small in the model's context.

[![npm](https://img.shields.io/npm/v/agent-julia.svg)](https://www.npmjs.com/package/agent-julia)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

```bash
npx agent-julia init
```

Every Claude surface forgets between sessions and keeps its own separate notes, so the same person gets a slightly different, amnesiac assistant on each one. The usual fix — piling everything into `CLAUDE.md` and global instructions — backfires, because long context measurably degrades the model. Agent Julia gives your AI a real brain instead: one memory you own as plain markdown, with only a small, budgeted slice loaded into context and the rest recalled on demand.

## Highlights

- **One memory, every surface** — Claude Code and Cowork share the same brain; a fact saved in one is known in the other.
- **You own it** — plain markdown in a git repo you control, not a database locked inside an app. Readable, portable, `git log`-able.
- **Small context footprint** — only a budgeted persona core rides each turn; everything else is recalled on demand, so the window stays clear.
- **Local and private by default** — no API key, no server, nothing leaves your machine (built-in `node:sqlite`; optional fully-local embeddings).
- **A persona that sticks** — the name, pronouns, and voice you set; corrections you make once apply everywhere, from the next turn.

---

## Install

```bash
npx agent-julia init
```

Requires **Node.js 24+** (it uses the built-in `node:sqlite` — no native module to compile or rebuild). There's no separate install step: `npx` fetches agent-julia into its own cache and runs the wizard in one go, and the MCP server launches the same way (`npx -y agent-julia@latest serve`), so it stays current. Prefer it installed permanently? `npm i -g agent-julia`.

The wizard walks you through your agent's name, pronouns, language, and voice; where your memory lives and whether to version it with git; search; and which Claude apps to register. It either writes a small persona block into each app's startup context — backed up first, inside a marked block, fully reversible — or prints the exact changes for you to make by hand (see [Manual setup](#manual-setup)).

When you're done, restart your Claude apps so they pick up the new MCP server.

## Usage

You don't call tools or memorize commands — you talk to your agent, and it reaches into memory on its own. A few natural examples:

**Save something** *(→ `ingest`)*

- "Remember that we dropped Redis — we're on Postgres LISTEN/NOTIFY now."
- "Note for the Privé project: the weekly review moved to Mondays."
- The agent also tries to capture durable facts on its own — but treat that as a
  bonus, not a guarantee (see the note below). Saying "remember: …" is the
  reliable channel.

> **On automatic capture.** agent-julia is an MCP server, which is *pull-only*:
> it never writes on its own, only when the model calls a tool. So "save this"
> happens only if the agent decides to call `ingest` mid-conversation — reliable
> when you ask explicitly ("remember: …"), best-effort when left to the agent's
> judgment, and easy to miss during a focused task. The persona core nudges it to
> capture and to say what it saved, so a miss is visible. If something important
> didn't land, just say "remember: …".

**Recall** *(→ `search`, `read`)*

- "What did we decide about auth?"
- "What do you know about the Privé pricing model?"
- "Did I say anything about onboarding last week?"

**Steer the voice** *(→ `correct_voice`)*

- "Stop hedging — commit to an answer."
- "Don't open every reply with my name."
- The correction is recorded and applied from the next turn, on every surface.

**Browse** *(→ `list`)*

- "What's in my memory?"  ·  "List every page you have."

**Think something through** *(→ the `brainstorm` skill)*

- "Help me decide whether to take the Berlin offer."
- "Let's brainstorm the pricing for the new plan."
- "Back to the office-move question from last week." — sessions are resumable;
  the state lives in memory, so you can start on one machine and finish on another.

Everything you save lands as markdown in your repo and is committed, so you can open it, edit it by hand, or `git log` the history any time.

## Why it helps

Two everyday frustrations it removes:

**A preference you keep re-teaching.** You tell Claude Code to skip the "Great question!" preamble and reply in Polish.

- *Before* — tomorrow, in Cowork on your laptop, the preamble is back and it answers in English. You correct it again. And again.
- *After* — you record it once with `correct_voice`; Code and Cowork both read the same correction from the next turn on.

**The `CLAUDE.md` tax.** Your `~/.claude/CLAUDE.md` has grown to 500 lines — every project, every preference, every person.

- *Before* — all of it loads on every turn of every session, and the answer degrades as the window fills with things this task doesn't need.
- *After* — about 1,200 tokens of persona ride each turn; the 500 lines live in your memory, and only the page you actually need is pulled in when you ask.

## How it works

- **Canonical store** — plain markdown in a git repo. Human-readable, portable, versioned, private. This is the source of truth, not a database.
- **Derived index** — SQLite (FTS5 full-text + optional vector embeddings) built from the markdown, via Node's built-in `node:sqlite` (no native module to compile). It's disposable: delete it and it rebuilds itself from your files.
- **Budgeted core** — a compact persona block is injected into Claude Code's `CLAUDE.md` and Claude Desktop's global instructions. It stays within a token budget you set, so it never crowds out the conversation.
- **One MCP server** — every surface talks to the same `agent-julia` server over stdio, so they share one memory and one persona.

## Skills

agent-julia ships one skill, installed by the wizard (and by `agent-julia sync`) into `~/.claude/skills/`, which both Claude Code and Cowork read:

**`brainstorm`** — a structured facilitator that takes a fuzzy idea or an open decision to a committed outcome. Built for business and life questions, not code. What makes it different from just chatting:

- **A real process** — frame (question, criteria, constraints) → diverge → challenge (assumptions, pre-mortem, inversion) → converge on a recommendation you confirm section by section.
- **One question per message**, with answer options — a dialogue, not a questionnaire.
- **Thinking lenses** — distillations of proven tools (strategy kernel, jobs-to-be-done, willingness to pay, fear-setting, inversion, regret minimization, one-way vs two-way doors…), picked to fit the topic and named when used.
- **Deep mode** — for high-stakes calls the agent offers a panel of 3–4 adversarial perspectives (skeptic, the other side, operator…) run as parallel subagents where available. It costs real tokens, so it never runs without your yes.
- **It remembers** — session state is saved to memory after every phase, so a brainstorm survives days and devices ("back to the X question"); the outcome lands as a decision doc with the options you killed and why, so nothing gets relitigated.
- **Your places, not hardcoded ones** — at the end it offers the doc as a Markdown/HTML file and, based on what tools *you* have connected, proposes where the actions should go.

The skill starts only when you ask for it (or accept a one-line offer). Your own skill under the same name is never overwritten: installs and uninstalls only touch copies carrying the `author: agent-julia` marker.

---

## Reference

Deeper detail — search, persona, the file layout, and the full configuration and command reference.

### Search

Two layers work together, and both run locally.

**Keyword (always on).** SQLite FTS5 with Porter stemming, so `debug` matches `debugging`, and diacritics folding, so `cafe` matches `café` and `krakow` matches `Kraków`. For languages without spaces between words — Chinese, Japanese, Korean, Thai — Agent Julia switches to a trigram tokenizer so substring search still works. The tokenizer is chosen from your configured language.

**Meaning (optional).** Turn on semantic search to find a note even when you phrase it differently, and across languages — a question in Polish can surface an English note. You choose how it runs:

- **Local model** — a multilingual model (the `multilingual-e5` family, ~118 languages) runs in-process. No server, no API key, fully offline after a one-time model download. Pick a size in the wizard: small (~120 MB download, ~0.3 GB RAM), base (~280 MB, ~0.6 GB), or large (~560 MB, ~1.3 GB). The size is a one-time download cached on disk; the model also loads into RAM while search runs. The wizard reads your machine's RAM and CPU cores and suggests a tier. RAM is rarely the limit — even the largest model needs only ~1.3 GB — so the suggestion leans on cores, since a bigger model's main cost is slower CPU inference per query. The real trade-off is download size and speed against quality. Needs one extra package, `@huggingface/transformers`, which stays optional so the base install is tiny.
- **Hosted API** — any OpenAI-compatible endpoint (OpenAI, or a local server like Ollama or LM Studio). Your key is read from an environment variable and never written to disk.
- **None** — stay keyword-only. The default, and completely dependency-free.

Hybrid mode blends keyword and meaning, and degrades gracefully: with no embeddings configured, it's simply keyword search.

### Persona

The persona has three layers, with a clear order when they disagree:

1. **User corrections** (highest) — short notes you record over time, like "don't use the word X" or "less hedging". Captured with the `correct_voice` tool, kept in `voice-corrections.md`, and applied above everything else. It's your agent.
2. **Universal core** — a small set of communication rules that apply to every persona: talk like a person, lead with a recommendation, skip filler.
3. **Style** (lowest) — either one of four shipped voices (sharp co-founder, calm mentor, minimalist engineer, neutral assistant) or your **own voice**. For the presets, the wizard shows the *same* message in all four, in your language, so you choose by ear. For a custom voice, pick "Write my own voice" and describe how the agent should speak in `persona.md`; it's used in place of a preset.

The composed persona core — identity, universal core, your style or custom voice, and corrections — is injected into each surface's startup context within your token budget, so the agent is always in character without fetching anything. (The `get_core` tool returns the same core on demand.)

Name, pronouns, and language are yours to set. The default persona is "Julia" (she/her), but you define your own.

### Memory model

Your store follows a simple, enforced layout:

```
your-memory/
  index.md     catalog of pages (kept current automatically)
  log.md       append-only journal of changes
  pages/       one page per topic, kebab-case
  archive/     retired pages, read-only
```

Pages carry light frontmatter — title, status, last-updated date, and an auto-detected language — and link to each other with `[[wiki-links]]`. Writing always goes through the `ingest` tool, which updates the page, refreshes the catalog, appends the journal, reindexes, and commits to git in one step.

Point the wizard at an existing markdown knowledge base and Agent Julia adopts it: your pages are indexed and a hand-written `index.md` is left alone — Agent Julia only manages a clearly marked block inside it.

Optionally back the store with a git remote — a private GitHub repo, say — set in the wizard or later with `agent-julia remote <url>`. By default it syncs on maintenance (and server startup), best-effort, so an offline moment or a missing credential never blocks a write; it just pushes on the next run. Turn on `gitAutoPush` to push after every write instead, trading a network round-trip per write for immediate off-machine backup. `agent-julia push` syncs on demand.

<details>
<summary><strong>Commands &amp; MCP tools</strong></summary>

You drive Agent Julia by talking to it (see [Usage](#usage)); these are the underlying tools and the CLI.

**MCP tools** (the agent calls these for you):

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

**CLI commands** (you run these):

| Command | |
| --- | --- |
| `agent-julia serve` | Start the MCP server (default; used by the Claude apps) |
| `agent-julia init` | Run the setup wizard |
| `agent-julia sync` | Re-apply registration and the persona block for the current config |
| `agent-julia uninstall` | Remove the managed blocks and registration (backups are kept) |
| `agent-julia remote [url]` | Show or set a git remote to back up your memory |
| `agent-julia push` | Push the memory store to its remote now |
| `agent-julia migrate` | Apply pending data migrations and exit |

</details>

<details>
<summary><strong>Configuration</strong></summary>

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

</details>

<details>
<summary><strong>Manual setup</strong> (registering without the wizard)</summary>

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

**Claude Desktop (Cowork)** — add the same `mcpServers` entry to the Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS), and paste the persona block into **Settings → Cowork → Global instructions**. Cowork keeps that field inside the app, so it can't be written for you — but `agent-julia init` and `agent-julia sync` copy the block to your clipboard, so it's a single paste.

> **Dispatch (mobile) isn't supported.** It can't run or reach the local stdio MCP server, and it doesn't read Cowork's Global instructions — so neither the memory tools nor the persona reach it in a local-first setup. Covering Dispatch would need the server hosted remotely, which is out of scope here.

The persona block is small on purpose — identity plus an instruction to use agent-julia for memory. Everything else is fetched on demand. When the wizard does this for you, it backs up each file first, writes inside a marked block, and `agent-julia uninstall` removes it cleanly.

</details>

<details>
<summary><strong>Maintenance &amp; upgrades</strong></summary>

Housekeeping runs on its own. On every write, and again when the server starts, Agent Julia reindexes changed pages, picks up files you edited by hand, flags stale-dated notes and broken links, refreshes the catalog, recompacts the persona core, and commits. Nothing is deleted without you — stale items are flagged, not removed.

A heavier weekly pass — for contradictions, duplicates, and deciding what to promote — is owner's-judgment work. Run `agent-julia maintenance` on whatever cadence suits you, or schedule it as a Claude Desktop task.

Upgrades are backward-compatible, or they ship an automatic migration that runs on first launch — backed up, idempotent, and transparent. The config carries a `schemaVersion`; ordered migration steps bring older stores forward on startup. The derived search index is disposable and simply rebuilds itself when its shape changes. `@latest` picks up new versions automatically next session; pin an exact version (`agent-julia@<version>`) if you want it fixed. Either way, upgrades never lose data and never ask you to hand-edit files.

</details>

## Releasing (maintainers)

CI runs typecheck, build, and tests on every pull request and push to `main` (Node 24). Releases are tag-driven:

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
