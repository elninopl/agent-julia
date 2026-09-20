import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// CLIENT-DEPENDENT, undocumented, may break without notice.
//
// Claude Desktop seeds each Cowork session with a copy of the instructions that
// were in force when it started, on disk, under a path nobody documents. That
// copy is the only evidence agent-julia can get about what the in-app field
// actually contains, because the field itself is unreadable from outside the
// app. Every path this package knows about lives in this file and nowhere else,
// and every failure here is "no signal", never a failed check.
function sessionRoots(): string[] {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return [join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions")];
    case "win32":
      return [
        join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "local-agent-mode-sessions"),
      ];
    default:
      return [join(home, ".config", "Claude", "local-agent-mode-sessions")];
  }
}

export interface CoworkProbe {
  status: "found" | "none" | "unreadable";
  /** Newest seeded block: 1 = the old long paste, 2 = the stable layer. */
  layout?: number;
  chars?: number;
  /** ISO date of the newest session that carried this exact block. */
  newest?: string;
  /** ISO date of the oldest consecutive session carrying the same block. */
  unchangedSince?: string;
  /** Voice corrections carried by that block, counted under their own heading. */
  corrections?: number;
}

const MAX_COMPARED = 50;
const MAX_SCANNED = 500;

export async function probeCoworkSession(): Promise<CoworkProbe> {
  try {
    const files: Array<{ path: string; mtime: number }> = [];
    for (const root of sessionRoots()) {
      if (!existsSync(root)) continue;
      await collect(root, files, 0);
    }
    if (files.length === 0) return { status: "none" };
    files.sort((a, b) => b.mtime - a.mtime);

    // Not every seeded file carries a block: Claude Desktop also leaves empty
    // placeholders, and they are often the newest thing on disk. Walk until a
    // real one turns up rather than concluding from the first.
    let newest: { path: string; mtime: number } | null = null;
    let body: string | null = null;
    for (const f of files.slice(0, MAX_COMPARED)) {
      const found = extractBlock(await readFile(f.path, "utf8").catch(() => ""));
      if (found !== null) {
        newest = f;
        body = found;
        break;
      }
    }
    if (!newest || body === null) return { status: "none" };
    const hash = createHash("sha1").update(body).digest("hex");

    // Walk back while the block is identical, to report a range rather than a
    // single date: "unchanged since" is the number that shows the drift.
    let unchangedSince = newest.mtime;
    for (const f of files.slice(files.indexOf(newest) + 1, MAX_COMPARED * 2)) {
      const other = extractBlock(await readFile(f.path, "utf8").catch(() => ""));
      if (other === null) continue;
      if (createHash("sha1").update(other).digest("hex") !== hash) break;
      unchangedSince = f.mtime;
    }

    return {
      status: "found",
      layout: classify(body),
      chars: body.length,
      newest: new Date(newest.mtime).toISOString().slice(0, 10),
      unchangedSince: new Date(unchangedSince).toISOString().slice(0, 10),
      corrections: countCorrections(body),
    };
  } catch {
    return { status: "unreadable" };
  }
}

async function collect(
  dir: string,
  out: Array<{ path: string; mtime: number }>,
  depth: number,
): Promise<void> {
  if (depth > 6 || out.length > MAX_SCANNED) return;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, out, depth + 1);
    } else if (entry.name === "CLAUDE.md") {
      const st = await stat(full).catch(() => null);
      if (st) out.push({ path: full, mtime: st.mtimeMs });
    }
  }
}

function extractBlock(content: string): string | null {
  const m = content.match(
    /<!-- agent-julia:persona-core:start[\s\S]*?<!-- agent-julia:persona-core:end -->/,
  );
  return m ? m[0] : null;
}

// Only the lines under the corrections heading: counting every bullet in the
// block would report the shipped communication rules as the user's corrections.
function countCorrections(body: string): number {
  const from = body.indexOf("## Corrections from the user");
  if (from < 0) return 0;
  const rest = body.slice(from);
  const to = rest.indexOf("\n## ", 1);
  return ((to < 0 ? rest : rest.slice(0, to)).match(/^- /gm) ?? []).length;
}

// Layout 2 announces itself in its first line; anything else carrying our
// markers is the long block that shipped before it.
function classify(body: string): number {
  return body.includes("agent-julia paste, layout 2") ? 2 : 1;
}
