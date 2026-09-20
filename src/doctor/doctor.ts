import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Config } from "../config/schema.js";
import { storePaths } from "../store/paths.js";
import { listPageIds, readPage } from "../store/markdown.js";
import { checkLocalEmbeddingsAvailable, LOCAL_EMBEDDINGS_PACKAGE, makeEmbeddingProvider } from "../index/embeddings.js";
import { ftsTokenizerFor, openDb } from "../index/db.js";
import { embeddedIds } from "../index/semantic.js";
import { readCorrections } from "../persona/corrections.js";
import { EXPORT_BLOCK_ID, exportText } from "../export/export.js";
import { isGitRepo, getRemoteUrl, gitAvailable } from "../store/git.js";
import { injectedCoreFrom, STARTUP_BLOCK_ID } from "../persona/startup.js";
import { composeCore } from "../persona/compose.js";
import { INSTRUCTIONS_BUDGET, coreHashOf, serverInstructions } from "../persona/startup.js";
import { PASTE_LAYOUT, configFingerprint, pasteBody, pasteHash } from "../persona/paste.js";
import { probeCoworkSession } from "../surfaces/cowork-probe.js";
import { estimateTokens } from "../util/tokens.js";
import { endMarker, hasManagedBlock, startMarker } from "../managed/block.js";
import { SHIPPED_SKILLS, shippedSkillsDir, skillsTargetDir } from "../skills/install.js";
import {
  claudeCodeConfigPath,
  claudeCodeMemoryPath,
  coworkMirrorPath,
  coworkPasteMarkerPath,
  desktopConfigPath,
  surfacesStatePath,
  readPasteMarker,
  readSurfaces,
} from "../wizard/register.js";

// "unknown" exists because the whole failure mode of the old design was a check
// claiming knowledge it did not have. agent-julia cannot read Claude Desktop's
// in-app instruction field; a check that cannot know must be able to say so
// without dressing it as health. It counts toward neither total.
export type DoctorStatus = "ok" | "warn" | "fail" | "unknown";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

// Everything doctor looks at, injectable so tests can point it at a sandbox.
export interface DoctorTargets {
  claudeCodeConfig: string;
  claudeCodeMemory: string;
  desktopConfig: string | null;
  coworkMirror: string;
  pasteMarker: string;
  surfaces: string;
  skillsDir: string;
}

export function defaultTargets(): DoctorTargets {
  return {
    claudeCodeConfig: claudeCodeConfigPath(),
    claudeCodeMemory: claudeCodeMemoryPath(),
    desktopConfig: desktopConfigPath(),
    coworkMirror: coworkMirrorPath(),
    pasteMarker: coworkPasteMarkerPath(),
    surfaces: surfacesStatePath(),
    skillsDir: skillsTargetDir(),
  };
}

async function hasMcpEntry(configPath: string): Promise<boolean> {
  if (!existsSync(configPath)) return false;
  try {
    const data = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Boolean(data.mcpServers && "agent-julia" in data.mcpServers);
  } catch {
    return false;
  }
}

// Run every check. Read-only: doctor never repairs anything itself — each
// finding says which command does.
export async function runDoctor(config: Config, t: DoctorTargets = defaultTargets()): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const paths = storePaths(config.memoryDir);
  const wantCode = config.surfaces.includes("code");
  const wantDesktop = config.surfaces.includes("cowork") || config.surfaces.includes("dispatch");

  // --- Node ---
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 24
      ? { name: "node", status: "ok", detail: `v${process.versions.node}` }
      : {
          name: "node",
          status: "fail",
          detail: `v${process.versions.node} — agent-julia needs Node 24+ (node:sqlite)`,
          fix: "nvm install 24 && nvm use 24",
        },
  );

  // --- Store ---
  if (!existsSync(config.memoryDir)) {
    checks.push({
      name: "store",
      status: "fail",
      detail: `memory directory missing: ${config.memoryDir}`,
      fix: "npx agent-julia init",
    });
    return checks; // everything else depends on the store
  }
  const pageCount = (await listPageIds(paths)).length;
  checks.push({ name: "store", status: "ok", detail: `${config.memoryDir} — ${pageCount} page(s)` });

  if (config.git && !(await gitAvailable())) {
    checks.push({
      name: "store git",
      status: "warn",
      detail:
        "git is on in config but not on PATH — the server runs without history this session " +
        "(Claude Desktop launched from Finder inherits launchd's PATH, not your shell's)",
      fix: "install git (macOS: xcode-select --install), or turn git off in the config",
    });
  } else if (config.git) {
    if (!isGitRepo(config.memoryDir)) {
      checks.push({
        name: "store git",
        status: "warn",
        detail: "git is on in config but the store is not a git repository",
        fix: "npx agent-julia init (or git init the store yourself)",
      });
    } else {
      const remote = await getRemoteUrl(config.memoryDir);
      checks.push({
        name: "store git",
        status: "ok",
        detail: remote ? `repo with remote ${remote}` : "repo (no remote — local-only backup)",
      });
    }
  }

  // --- Every page the catalog lists must actually open ---
  {
    const ids = await listPageIds(paths);
    const missing: string[] = [];
    const unparsed: string[] = [];
    for (const id of ids) {
      const page = await readPage(paths, id);
      if (page === null) missing.push(id);
      else if (page.frontmatterError) unparsed.push(id);
    }
    if (missing.length) {
      checks.push({
        name: "pages readable",
        status: "fail",
        detail: `${missing.length} page(s) are listed but cannot be opened: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`,
        fix: "check those files exist and are readable",
      });
    } else if (unparsed.length) {
      checks.push({
        name: "pages readable",
        status: "warn",
        detail:
          `${ids.length} page(s) open; ${unparsed.length} have front matter that will not parse, so their title and status are ignored: ` +
          `${unparsed.slice(0, 5).join(", ")}${unparsed.length > 5 ? ", …" : ""}`,
        fix: "fix the YAML between the --- delimiters in those files",
      });
    } else if (ids.length) {
      checks.push({ name: "pages readable", status: "ok", detail: `all ${ids.length} page(s) open` });
    }
  }

  // --- Derived index: open it, don't just look for the file ---
  let embedded: number | null = null;
  if (!existsSync(paths.dbPath)) {
    checks.push({
      name: "index",
      status: "warn",
      detail: "no index database yet — it is built on the first server start",
    });
  } else {
    try {
      const db = openDb(paths, ftsTokenizerFor(config.language));
      embedded = embeddedIds(db).length;
      db.close();
      checks.push({ name: "index", status: "ok", detail: paths.dbPath });
    } catch (err) {
      checks.push({
        name: "index",
        status: "fail",
        detail: `the index database will not open: ${(err as Error).message.split("\n")[0]}`,
        fix: `delete ${paths.dbPath} — the index is disposable and rebuilds from your markdown`,
      });
    }
  }

  // --- Semantic search: does the configured provider actually load? ---
  // Checking the config says nothing. The failure this catches is silent by
  // construction: the provider throws on first use, the warning goes to stderr,
  // which for an MCP server is a log nobody opens, and search quietly drops back
  // to keywords while the vectors sit in the database unused.
  {
    const provider = config.embedding.provider;
    if (provider === "none") {
      checks.push({
        name: "semantic search",
        status: "ok",
        detail: "off — keyword search only (no model, no network)",
      });
    } else if (provider === "local") {
      if (!(await checkLocalEmbeddingsAvailable())) {
        checks.push({
          name: "semantic search",
          status: "fail",
          detail:
            `configured as "local", but ${LOCAL_EMBEDDINGS_PACKAGE} cannot be loaded by this process — ` +
            "if the registered server runs from the same install, every search there silently falls back to keywords",
          fix:
            `install both in the same place, then re-run init: npm i -g agent-julia ${LOCAL_EMBEDDINGS_PACKAGE}. ` +
            "A server registered as `npx agent-julia@latest` cannot see a globally installed model package.",
        });
      } else {
        const pages = (await listPageIds(paths)).length;
        const gap = embedded === null ? "" : `, ${embedded}/${pages} page(s) embedded`;
        checks.push({
          name: "semantic search",
          status: embedded !== null && pages > 0 && embedded < pages ? "warn" : "ok",
          detail: `local model ${makeEmbeddingProvider(config.embedding).id}${gap}`,
          ...(embedded !== null && pages > 0 && embedded < pages
            ? { fix: "run `agent-julia maintenance` to embed the pages that are missing" }
            : {}),
        });
      }
    } else {
      const key = process.env[config.embedding.apiKeyEnv];
      checks.push({
        name: "semantic search",
        status: key ? "ok" : "warn",
        detail: key
          ? `hosted endpoint ${config.embedding.baseUrl ?? "https://api.openai.com/v1"} (every page is sent there)`
          : `hosted endpoint configured but ${config.embedding.apiKeyEnv} is not set — search falls back to keywords`,
        ...(key ? {} : { fix: `export ${config.embedding.apiKeyEnv}=… before starting the server` }),
      });
    }
  }

  // --- MCP registration ---
  if (wantCode) {
    checks.push(
      (await hasMcpEntry(t.claudeCodeConfig))
        ? { name: "mcp (code)", status: "ok", detail: t.claudeCodeConfig }
        : {
            name: "mcp (code)",
            status: "fail",
            detail: `agent-julia is not registered in ${t.claudeCodeConfig}`,
            fix: "npx agent-julia sync",
          },
    );
  }
  if (wantDesktop && t.desktopConfig) {
    checks.push(
      (await hasMcpEntry(t.desktopConfig))
        ? { name: "mcp (cowork)", status: "ok", detail: t.desktopConfig }
        : {
            name: "mcp (cowork)",
            status: "fail",
            detail: `agent-julia is not registered in ${t.desktopConfig}`,
            fix: "npx agent-julia sync",
          },
    );
  }

  // --- Persona block: Claude Code ---
  const composed = await composeCore(paths, config);
  const core = injectedCoreFrom(composed.text);

  // --- Persona: does the core fit the budget it declares? ---
  // Checked before the block checks below, because a block that is present and
  // current is still wrong if the voice inside it was cut in half.
  if (composed.truncated || composed.droppedCorrections > 0) {
    const lost = [
      composed.truncated ? "the style voice was cut off" : null,
      composed.droppedCorrections > 0
        ? `${composed.droppedCorrections} correction(s) left out of context`
        : null,
    ].filter(Boolean);
    checks.push({
      name: "persona budget",
      status: "warn",
      detail: `core needs more than contextBudget ${config.contextBudget} — ${lost.join(", ")}`,
      fix: "raise contextBudget in the config, or shorten persona.md / voice-corrections.md",
    });
  } else {
    checks.push({
      name: "persona budget",
      status: "ok",
      detail: `core ${composed.tokens}/${config.contextBudget} tokens; injected block ${estimateTokens(core)} (core + memory instruction)`,
    });
  }
  const block = `${startMarker(STARTUP_BLOCK_ID)}\n${core.trim()}\n${endMarker(STARTUP_BLOCK_ID)}`;
  if (wantCode) {
    const content = existsSync(t.claudeCodeMemory) ? await readFile(t.claudeCodeMemory, "utf8") : "";
    if (!hasManagedBlock(content, STARTUP_BLOCK_ID)) {
      checks.push({
        name: "persona (code)",
        status: "fail",
        detail: `no persona block in ${t.claudeCodeMemory}`,
        fix: "npx agent-julia sync",
      });
    } else if (!content.includes(block)) {
      checks.push({
        name: "persona (code)",
        status: "warn",
        detail: "persona block is stale — it refreshes on the next server start",
        fix: "npx agent-julia sync (to refresh now)",
      });
    } else {
      checks.push({ name: "persona (code)", status: "ok", detail: "block present and current" });
    }
  }

  // --- Claude Desktop: what we asked for, what a session was seen with, and
  // whether the voice ever actually arrives. Three separate questions, because
  // agent-julia cannot read the in-app field and must never pretend otherwise.
  if (wantDesktop) {
    const CANNOT_READ = "agent-julia cannot read the in-app field, so this is about the request, not the field.";
    const marker = await readPasteMarker(t.pasteMarker);
    const body = await pasteBody(config);
    if (!marker) {
      checks.push({
        name: "paste (desktop)",
        status: "warn",
        detail: `no record that agent-julia ever asked you to paste anything on this machine. ${CANNOT_READ}`,
        fix: "npx agent-julia paste",
      });
    } else if (marker.variant === "with-voice") {
      // A deliberate choice, not drift: the long variant carries the voice on
      // purpose, for accounts that reach surfaces with no connector.
      checks.push({
        name: "paste (desktop)",
        status: "ok",
        detail:
          `you chose the long variant on ${marker.askedAt.slice(0, 10)}; it carries a frozen copy of your ` +
          `voice, so it does go stale as you record corrections. Re-run \`agent-julia paste --with-voice\` ` +
          `after a batch of them. ${CANNOT_READ}`,
      });
    } else if (marker.layout !== PASTE_LAYOUT) {
      checks.push({
        name: "paste (desktop)",
        status: "warn",
        detail:
          `you were last asked to paste layout ${marker.layout} (the old long block with a frozen copy of ` +
          `your voice). get_core overrides it, so nothing breaks, but it costs roughly 2,400 tokens a conversation.`,
        fix: "npx agent-julia paste",
      });
    } else if (marker.configFingerprint !== configFingerprint(config)) {
      checks.push({
        name: "paste (desktop)",
        status: "warn",
        detail:
          "the stable layer changed since you were asked to paste it (name, output language or never-store list). " +
          CANNOT_READ,
        fix: "npx agent-julia paste",
      });
    } else if (marker.stableHash !== pasteHash(body)) {
      checks.push({
        name: "paste (desktop)",
        status: "warn",
        detail:
          "the wording of the shipped template changed in this package release. Your existing paste is still " +
          "correct; re-pasting is optional. " +
          CANNOT_READ,
        fix: "npx agent-julia paste",
      });
    } else {
      checks.push({
        name: "paste (desktop)",
        status: "ok",
        detail: `last asked on ${marker.askedAt.slice(0, 10)} for layout ${marker.layout}, still current. ${CANNOT_READ}`,
      });
    }

    // The only real evidence: what Claude Desktop seeded its last session with.
    const probe = await probeCoworkSession();
    if (probe.status === "unreadable") {
      checks.push({
        name: "paste seen",
        status: "unknown",
        detail: "could not read Claude Desktop's session files (undocumented path, it may have moved). No signal either way.",
      });
    } else if (probe.status === "none") {
      checks.push({
        name: "paste seen",
        status: "unknown",
        detail: "no Cowork session on this machine carried an agent-julia block, so there is nothing to read.",
      });
    } else if (probe.layout === PASTE_LAYOUT) {
      checks.push({
        name: "paste seen",
        status: "ok",
        detail: `the last Cowork session (${probe.newest}) was seeded with the current layout-${probe.layout} paste. That is what that session got, not what the field holds now.`,
      });
    } else {
      const mine = (await composeCore(paths, config)).text.match(/^- /gm)?.length ?? 0;
      checks.push({
        name: "paste seen",
        status: "warn",
        detail:
          `the last Cowork session (${probe.newest}) ran with a layout-${probe.layout} block, ${probe.chars} chars, ` +
          `unchanged since ${probe.unchangedSince} — carrying ${probe.corrections} voice correction(s) against ${mine} lines of voice here.`,
        fix: "npx agent-julia paste",
      });
    }

    // Does the volatile half actually arrive? Absolute numbers only: Desktop
    // runs one long-lived process for many conversations, so there is no
    // denominator worth quoting.
    const surfaces = await readSurfaces(t.surfaces);
    const desktopBoot = Object.entries(surfaces.boots ?? {}).find(([k]) => k !== "claude-code");
    const desktopFetch = Object.entries(surfaces.fetches ?? {}).find(([k]) => k !== "claude-code");
    if (!desktopBoot) {
      checks.push({
        name: "voice fetch",
        status: "unknown",
        detail: "the server has never started from Claude Desktop on this machine, so nothing can be said about it.",
      });
    } else if (!desktopFetch) {
      checks.push({
        name: "voice fetch",
        status: "warn",
        detail:
          `the server has started from Claude Desktop (${desktopBoot[0]}) but get_core has never been called there ` +
          "— the paste is probably missing, or the connector is off in your conversations.",
        fix: "npx agent-julia paste",
      });
    } else {
      const current = coreHashOf(composed.text).slice(0, 8) === desktopFetch[1].coreHash.slice(0, 8);
      checks.push({
        name: "voice fetch",
        status: current ? "ok" : "warn",
        detail: current
          ? `${desktopFetch[0]} last loaded the voice ${desktopFetch[1].at.slice(0, 16).replace("T", " ")} (core ${desktopFetch[1].coreHash.slice(0, 8)}, current).`
          : `${desktopFetch[0]} last loaded the voice ${desktopFetch[1].at.slice(0, 10)} (core ${desktopFetch[1].coreHash.slice(0, 8)}), which is not the current one.`,
      });
    }
  }

  // --- What every client is told on connect ---
  {
    const instructions = serverInstructions(config);
    const BUDGET = INSTRUCTIONS_BUDGET;
    checks.push({
      name: "mcp instructions",
      status: instructions.length <= BUDGET ? "ok" : "warn",
      detail:
        instructions.length <= BUDGET
          ? `${instructions.length} chars of ${BUDGET} (clients truncate around 2,048).`
          : `${instructions.length} chars — over budget, so paragraphs were dropped from what clients receive. Shorten your privacyHardOff list.`,
      ...(instructions.length <= BUDGET ? {} : { fix: "shorten privacyHardOff in the config" }),
    });
  }

  // --- Skills ---
  for (const skill of SHIPPED_SKILLS) {
    const shippedManifest = join(shippedSkillsDir(), skill, "SKILL.md");
    const installedManifest = join(t.skillsDir, skill, "SKILL.md");
    if (!existsSync(installedManifest)) {
      checks.push({
        name: `skill '${skill}'`,
        status: "warn",
        detail: "not installed — it installs on the next server start",
        fix: "npx agent-julia sync (to install now)",
      });
      continue;
    }
    const same =
      existsSync(shippedManifest) &&
      (await readFile(shippedManifest, "utf8")) === (await readFile(installedManifest, "utf8"));
    checks.push(
      same
        ? { name: `skill '${skill}'`, status: "ok", detail: installedManifest }
        : {
            name: `skill '${skill}'`,
            status: "warn",
            detail: "installed copy differs from the shipped version (yours, or an update pending)",
          },
    );
  }

  // --- Exported persona files ---
  if (config.exports.length > 0) {
    const text = await exportText(config);
    const exportBlock = `${startMarker(EXPORT_BLOCK_ID)}\n${text.trim()}\n${endMarker(EXPORT_BLOCK_ID)}`;
    for (const p of config.exports) {
      if (!existsSync(p)) {
        checks.push({
          name: "export",
          status: "warn",
          detail: `recorded export file is gone: ${p}`,
          fix: `agent-julia export ${p} (to recreate) or agent-julia export --remove ${p}`,
        });
      } else {
        const content = await readFile(p, "utf8");
        if (!hasManagedBlock(content, EXPORT_BLOCK_ID)) {
          checks.push({
            name: "export",
            status: "warn",
            detail: `no persona block in ${p} (removed by hand?)`,
            fix: `agent-julia export ${p} or agent-julia export --remove ${p}`,
          });
        } else if (!content.includes(exportBlock)) {
          checks.push({
            name: "export",
            status: "warn",
            detail: `${p} is stale — it refreshes on the next server start`,
          });
        } else {
          checks.push({ name: "export", status: "ok", detail: p });
        }
      }
    }
  }

  // --- Voice corrections hygiene ---
  const corrections = await readCorrections(paths);
  if (corrections.length > 20) {
    checks.push({
      name: "voice corrections",
      status: "warn",
      detail: `${corrections.length} corrections on file — the oldest stop riding in the injected core once the budget fills`,
      fix: "consolidate voice-corrections.md into fewer, broader rules (it is a plain markdown file)",
    });
  }

  // --- Backups hygiene (informational) ---
  if (existsSync(paths.backupsDir)) {
    const n = (await readdir(paths.backupsDir)).length;
    if (n > 20) {
      checks.push({
        name: "backups",
        status: "warn",
        detail: `${n} migration backups in ${paths.backupsDir} — safe to prune old ones by hand`,
      });
    }
  }

  return checks;
}

const ICONS: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗", unknown: "?" };

export function formatChecks(checks: DoctorCheck[]): string {
  const lines = checks.map((c) => {
    const head = `${ICONS[c.status]} ${c.name.padEnd(16)} ${c.detail}`;
    return c.fix && c.status !== "ok" ? `${head}\n    fix: ${c.fix}` : head;
  });
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  // "unknown" counts toward neither: a question that cannot be answered is not
  // a problem and is certainly not health.
  const unknown = checks.filter((c) => c.status === "unknown").length;
  const tail = unknown > 0 ? ` ${unknown} thing(s) agent-julia cannot check.` : "";
  const summary =
    fails > 0
      ? `${fails} problem(s), ${warns} warning(s).${tail}`
      : warns > 0
        ? `Healthy, with ${warns} warning(s).${tail}`
        : `Everything looks healthy.${tail}`;
  return [...lines, "", summary].join("\n");
}
