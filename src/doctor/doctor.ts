import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Config } from "../config/schema.js";
import { storePaths } from "../store/paths.js";
import { listPageIds } from "../store/markdown.js";
import { readCorrections } from "../persona/corrections.js";
import { isGitRepo, getRemoteUrl } from "../store/git.js";
import { buildInjectedCore, STARTUP_BLOCK_ID } from "../persona/startup.js";
import { endMarker, hasManagedBlock, startMarker } from "../managed/block.js";
import { SHIPPED_SKILLS, shippedSkillsDir, skillsTargetDir } from "../skills/install.js";
import {
  claudeCodeConfigPath,
  claudeCodeMemoryPath,
  coreHash,
  coworkMirrorPath,
  coworkPasteMarkerPath,
  desktopConfigPath,
} from "../wizard/register.js";

export type DoctorStatus = "ok" | "warn" | "fail";

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
  skillsDir: string;
}

export function defaultTargets(): DoctorTargets {
  return {
    claudeCodeConfig: claudeCodeConfigPath(),
    claudeCodeMemory: claudeCodeMemoryPath(),
    desktopConfig: desktopConfigPath(),
    coworkMirror: coworkMirrorPath(),
    pasteMarker: coworkPasteMarkerPath(),
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

  if (config.git) {
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

  // --- Derived index ---
  checks.push(
    existsSync(paths.dbPath)
      ? { name: "index", status: "ok", detail: paths.dbPath }
      : {
          name: "index",
          status: "warn",
          detail: "no index database yet — it is built on the first server start",
        },
  );

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
  const core = await buildInjectedCore(paths, config);
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

  // --- Persona: Cowork drift ---
  if (wantDesktop) {
    if (!existsSync(t.pasteMarker)) {
      checks.push({
        name: "persona (cowork)",
        status: "warn",
        detail: "no record of a Cowork paste — the in-app Global instructions may be empty or stale",
        fix: "npx agent-julia sync, then paste as instructed",
      });
    } else {
      const pasted = (await readFile(t.pasteMarker, "utf8")).trim();
      if (pasted === coreHash(core)) {
        checks.push({ name: "persona (cowork)", status: "ok", detail: "in-app paste matches the current core" });
      } else {
        checks.push({
          name: "persona (cowork)",
          status: "warn",
          detail:
            "the persona core changed since you last pasted it into Cowork — the in-app copy has drifted",
          fix: "npx agent-julia sync, then re-paste into Claude Desktop → Settings → Cowork → Global instructions",
        });
      }
    }
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

const ICONS: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatChecks(checks: DoctorCheck[]): string {
  const lines = checks.map((c) => {
    const head = `${ICONS[c.status]} ${c.name.padEnd(16)} ${c.detail}`;
    return c.fix && c.status !== "ok" ? `${head}\n    fix: ${c.fix}` : head;
  });
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const summary =
    fails > 0
      ? `${fails} problem(s), ${warns} warning(s).`
      : warns > 0
        ? `Healthy, with ${warns} warning(s).`
        : "Everything looks healthy.";
  return [...lines, "", summary].join("\n");
}
