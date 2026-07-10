# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/). MAJOR bumps are reserved for breaking
changes, which always ship an automatic, backup-protected data migration.

## [Unreleased]

## [0.1.35] - 2026-07-10

### Added

- **Two-machine sync:** with a git remote configured, the server pulls the
  store on startup (best-effort, non-interactive — offline is a quiet skip),
  so a session on one machine starts from what the other pushed. A merge
  conflict is aborted rather than left half-done, and reported for a by-hand
  resolve. New `agent-julia pull` runs the same pull on demand.

### Fixed

- The wizard's weekly-review step no longer promises an approval digest that
  doesn't exist yet — it now describes what scheduled maintenance actually
  does (reindex, catalog refresh, stale/orphan flagging).

## [0.1.34] - 2026-07-10

### Changed

- Voice corrections are compacted before injection: exact repeats are deduped
  (the newest occurrence wins), and when the list outgrows the context budget
  the oldest corrections stay in `voice-corrections.md` instead of riding in
  the core — a counter line says how many, so nothing disappears silently.
  Previously the protected corrections tail could grow past the entire budget
  and squeeze the actual voice down to its 100-token floor.
- `doctor` warns when more than 20 corrections are on file and suggests
  consolidating them.

### Added

- Test coverage for the semantic and hybrid search paths (deterministic fake
  embedding provider — ranking by meaning, keyword+vector fusion) and a
  regression test for the 0.1.31 re-embed gap-fill fix. This half of search
  previously had no tests at all.

## [0.1.33] - 2026-07-10

### Added

- **`agent-julia doctor`** — a read-only health check for the whole
  installation: Node version, store and git state, index presence, MCP
  registration on each surface, persona block present and current in
  `~/.claude/CLAUDE.md`, shipped skills installed and current — each finding
  with the command that fixes it.
- Doctor also detects **Cowork persona drift**: `init`/`sync` now record a hash
  of the core you were asked to paste, and when the core has changed since,
  doctor tells you the in-app Global instructions are stale and need a
  re-paste. Previously this failure mode was completely silent.

## [0.1.32] - 2026-07-10

Republish of 0.1.31: its release run failed in CI on a broken npm
toolchain before anything reached the registry, so 0.1.31 was never
published. This version adds only the CI fix on top.

## [0.1.31] - 2026-07-10

### Security

- Page ids are now sanitized to a safe character set. Previously a crafted id
  (`../../…`) passed to the `read`/`ingest` tools could read or write `.md`
  files **outside the memory store** — including `~/.claude/CLAUDE.md`. Ids
  can no longer traverse out of `pages/`.
- Managed-block bodies are hardened: text quoting the block's own end marker
  can no longer close the region early and leak block content into the host
  file, and `$`-patterns in the body no longer corrupt it on replace.

### Fixed

- A single failed embedding no longer triggers a full re-embed of the entire
  store on every server start (the full cost of the embedding API, every
  session, until the page stopped failing) — only the missing pages are
  embedded now.
- Deleting a page file by hand is now noticed by the startup maintenance gate
  (the pages directory's own mtime is included), so removed pages leave the
  index and catalog instead of lingering until an unrelated change.
- On a git-lock wait timeout the operation is skipped and retried with the
  next write, instead of running unlocked and racing the very commits the
  lock exists to protect.
- FTS search results carry a real relevance score again — bm25 ranks are
  negative for matches, and the old normalization clamped every match to a
  flat 1.0.
- The MCP server now reports its real package version instead of a hardcoded
  `0.1.0`.

## [0.1.30] - 2026-07-07

### Added

- Core voice: when the task is ambiguous, the agent asks before starting instead
  of guessing — trivial, unambiguous requests excluded. Applies to every persona
  preset.
- The server now also refreshes the injected persona block on boot, wherever the
  block already exists — so voice updates and recorded corrections reach Claude
  Code (and the Cowork mirror file) automatically, without a manual `sync`. The
  refresh never creates a block, only updates ones you installed, and rewrites a
  file only when the content actually changed. The Cowork in-app Global
  instructions field still needs a one-time re-paste to pick up changes.

## [0.1.29] - 2026-07-07

### Added

- **`brainstorm` skill** — a structured brainstorm facilitator shipped with the
  package and installed into `~/.claude/skills/` by the wizard and `sync`
  (removed by `uninstall`). It runs a five-phase process (frame → diverge →
  challenge → converge → commit) with one question per message, thinking lenses
  for business and life topics, an opt-in deep mode (a panel of adversarial
  perspectives), and session state persisted to memory after every phase, so a
  brainstorm is resumable across days and devices and ends in a decision doc.
  Installs never overwrite a user's own skill of the same name — only copies
  marked `author: agent-julia` are managed.
- The server refreshes the shipped skills on every boot, so existing installs
  (which run the floating `agent-julia@latest`) pick up new and updated skills
  automatically — no manual `sync` needed. Only copies carrying the
  `author: agent-julia` ownership marker are ever touched.

## [0.1.28] - 2026-06-26

### Changed

- The persona core now asks the agent to capture **visibly** — say in one line
  what it saved (`saved → page-id`) — so a missed capture is obvious instead of
  silent, and states plainly that explicit "remember: …" is the reliable channel
  while proactive capture is best-effort.
- README: an honest note that automatic capture is pull-only (the server never
  writes on its own, only when the model calls a tool), so it's best-effort;
  "remember: …" is the dependable way to save something.

## [0.1.27] - 2026-06-26

### Fixed

- User voice corrections (L3, highest precedence) were appended to the budgeted
  body and so were the first thing `clampToBudget` trimmed when the core was over
  budget — the highest-precedence layer dropped first. Corrections are now in the
  protected tail alongside the privacy rail, so they always survive. Added a
  regression test.

### Changed

- Stronger instruction to capture voice corrections: when the user corrects how
  the agent writes or speaks, even in passing, call `correct_voice` before
  replying and confirm it's saved, rather than only acknowledging it in chat.

## [0.1.26] - 2026-06-23

### Changed

- Startup maintenance is skipped when nothing on disk changed since the last run.
  Each Claude session spawns its own `serve`, so running full maintenance (read
  every page, refresh the catalog, git add/commit) on every cold start was pure
  repeated cost. A cheap mtime check (readdir + stat, no content reads) gates it;
  the explicit `maintenance` tool/command still always runs in full.
- The WAL is capped (`wal_autocheckpoint`) and truncated on clean shutdown, so
  the `-wal` file no longer grows large and stays mmapped across instances.

### Fixed

- The server now exits when its client disconnects (stdin/transport close), not
  only on SIGINT/SIGTERM. Previously a session that closed its pipe without a
  signal could leave the `serve` process — and its npm-exec wrapper — running for
  hours, accumulating across sessions.

## [0.1.25] - 2026-06-23

### Changed

- README restructured for readability: a scannable top (hook, highlights,
  install, usage), then "Why it helps" and "How it works", then a Reference
  appendix. The long configuration, command/tool, manual-setup, and maintenance
  sections are collapsed under `<details>`. Trimmed the problem framing into a
  three-line lead and cut the before/after examples from three to two.

## [0.1.24] - 2026-06-23

### Changed

- README: add a short "Why Agent Julia" highlight list near the top, and a Usage
  section showing how you actually work with the agent in natural language
  (save, recall, steer the voice, browse) and which tool each maps to.

## [0.1.23] - 2026-06-23

### Changed

- Scope is now Claude Code and Cowork (Claude Desktop). Dispatch is no longer
  offered as a surface: it runs on mobile, can't reach the local stdio MCP
  server, and doesn't read Cowork's Global instructions — so a local-first setup
  can't deliver memory or persona there. Covering it would need a remotely hosted
  server. The wizard, README, and package description no longer claim Dispatch.

### Compatibility

- `dispatch` is still accepted in an existing config's `surfaces` (treated as
  Cowork), so older installs keep working without a migration.

## [0.1.22] - 2026-06-22

### Changed

- `init` and `sync` copy the Cowork persona block to the clipboard and print a
  1-2-3 paste instruction, instead of just pointing at the mirror file. Cowork's
  Global instructions can't be written programmatically, so this makes the one
  manual step a single paste — and harder to forget (a forgotten paste is why a
  surface like Dispatch can end up without the persona). Best-effort: falls back
  to the file path when no clipboard tool is available.

## [0.1.21] - 2026-06-22

### Changed

- README: add a banner image at the top.

## [0.1.20] - 2026-06-22

### Changed

- README: the problem section now leads with the core idea — your AI has no
  persistent brain, each surface keeps amnesiac scraps — and carries the brain
  metaphor through to the fix, with before/after examples. Uses "Agent Julia" as
  the display name; "agent-julia" stays the package and command.
- CI/release run on `actions/checkout@v5` and `actions/setup-node@v5` (Node 24
  runtime; the v4 actions used the deprecated Node 20).

## [0.1.19] - 2026-06-22

### Fixed

- Concurrent surfaces no longer corrupt the store. SQLite waits on a busy
  writer (`busy_timeout`) instead of failing, and git commit/push run under a
  cross-process lock, so two surfaces committing at once can't race on
  `.git/index.lock` and silently drop a write.
- A page's FTS row, embedding, and content hash are now written in a single
  transaction, so a crash can't record a hash for a page whose embedding never
  landed (which would leave it permanently unsearchable by meaning).
- Switching the embedding provider from `none` to `local` (or adding one to an
  existing store) now embeds the pages that were indexed before — previously
  semantic search returned nothing for them until each was re-saved by hand.
- Stored vectors are read through an aligned buffer, fixing a latent
  `RangeError` that could crash semantic search depending on memory layout.
- A store written by a newer agent-julia is refused with a clear upgrade
  message instead of being silently downgraded.
- Setup aborts when stdin isn't an interactive terminal, instead of racing
  through the wizard on defaults and editing Claude config files unattended.
- MCP registration reports a manual step when a Claude config file isn't valid
  JSON, instead of showing a success it didn't perform.
- `git push` rejection (remote ahead of local) is reported distinctly so a
  backup that isn't actually happening doesn't look fine.

### Changed

- Hybrid search uses reciprocal-rank fusion and gives semantic-only hits their
  real title; multi-word keyword queries are matched with AND for precision.
- Custom persona budget is clamped to 400–8000 tokens.
- Invalid menu input in the wizard re-prompts instead of snapping to the default.
- Migration backups now include `persona.md`.

## [0.1.18] - 2026-06-22

### Fixed

- `verifyRemote` no longer reports an empty but reachable remote as unreachable
  (dropped `git ls-remote --exit-code`, which treats a fresh repo with no refs as
  a failure). Setup against a new empty backup repo now passes.

## [0.1.17] - 2026-06-22

### Changed

- The injected persona core reads as direct instruction, not a serialized config:
  a natural identity sentence instead of a Name/Gender/Style/Precedence key-value
  dump, and lighter section headers ("How you communicate", "Your voice").
- Stronger proactive-memory instruction: the agent is told to `ingest` durable
  facts, decisions, and preferences on its own as they surface — not only when
  explicitly asked — while skipping transient chatter.

### Added

- `verifyRemote`: the wizard and `agent-julia remote` check the git remote is
  reachable at setup and warn if it isn't, instead of failing silently until the
  next maintenance push.

## [0.1.16] - 2026-06-22

### Changed

- Switched the search index from the native `better-sqlite3` module to Node's
  built-in `node:sqlite`. No native module to compile, prebuild, or rebuild — so
  `npx agent-julia@latest serve` works regardless of Node version or a stale npx
  cache (the previous setup could crash with a NODE_MODULE_VERSION ABI mismatch
  after a Node upgrade). **Requires Node.js 24+** (raised from 20).
- CI and release now run on Node 24.

### Changed

- The injected persona core no longer carries the core-voice credits/attribution
  or its title — only the rules. Attribution stays in the source file and README,
  out of the always-on context.

## [0.1.14] - 2026-06-22

### Changed

- The universal core voice now bakes in concrete "signs of AI writing" rules to
  avoid (inflated significance, superficial -ing tails, AI vocabulary, vague
  attributions, negative parallelism, em-dash overuse, …) instead of pointing at
  an external repo. Credited in the file and the README.
- The wizard shows the `persona.md` path on its own line and gives step-by-step
  instructions (with the file path) for pasting the persona core into Cowork.

### Fixed

- The test suite no longer writes to the real `~/.config/agent-julia/config.json`.
  `migrate()` persists via `saveConfig()`, so tests now pin `AGENT_JULIA_CONFIG`
  to a throwaway path; previously running the suite could overwrite a developer's
  actual config.

## [0.1.13] - 2026-06-22

### Changed

- Wizard makes the custom-voice flow explicit: it points you to `persona.md` and
  tells you to run `agent-julia sync` after writing your voice.
- The Cowork step now reads as an action ("action needed — paste the persona core
  into Cowork") instead of an ambiguous status, and the closing "Next" list only
  shows the steps that actually apply (custom voice, Cowork paste, restart, …).

### Added

- `gitAutoPush` (default off): push after every write, not just on maintenance —
  immediate off-machine backup at the cost of a network round-trip per write. The
  wizard offers it when a remote is configured.

## [0.1.11] - 2026-06-22

### Added

- Optional git remote for the memory store (e.g. a private GitHub repo): set it in
  the wizard or with `agent-julia remote <url>`. Maintenance and server startup
  push to it best-effort (non-interactive, never blocks on credentials or offline).
  `agent-julia push` syncs on demand.

## [0.1.10] - 2026-06-22

### Added

- Custom voice: pick "Write my own voice" in the wizard and describe how the agent
  should speak in `persona.md`, used in place of a preset.

### Changed

- The full persona core (identity + universal core + style/custom voice +
  corrections + privacy) is now injected into each surface's startup context
  within the token budget, so the agent is always in character — instead of a
  minimal stub that deferred the voice to a `get_core` tool call.

## [0.1.9] - 2026-06-22

### Changed

- If the native SQLite engine can't load, the error now explains why and how to
  fix it (rebuild, or use a supported Node LTS) instead of printing a raw stack.
- Added an `author` field to the package metadata.

## [0.1.8] - 2026-06-22

### Changed

- README: clarify that `npx agent-julia init` fetches and runs in one step (no
  separate install), and note that the model suggestion uses CPU cores as well as
  RAM.

## [0.1.7] - 2026-06-22

### Added

- Setup offers a choice for changes to your Claude config: have the wizard apply
  them, or print the exact edits to make by hand. `agent-julia sync --print`
  shows them any time.
- Git versioning of the memory store is now a wizard option (on by default). With
  it off, the store stays plain, unversioned markdown.

### Changed

- Recording a voice correction now commits, like every other write.
- The local-model suggestion considers CPU cores as well as RAM, since a larger
  model's main cost is slower CPU inference per query.

### Changed

- The local-model picker now shows each tier's download size and RAM use
  separately, reads the machine's total RAM, and suggests a tier from it.

## [0.1.5] - 2026-06-21

### Changed

- The compiled package no longer ships source comments.

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
