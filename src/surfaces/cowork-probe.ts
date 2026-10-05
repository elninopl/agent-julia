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
export function coworkSessionRoots(): string[] {
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
  /**
   * "found": the newest session was seeded with an agent-julia block.
   * "none": there is no session, or the newest one left no block on disk.
   */
  status: "found" | "none" | "unreadable";
  /** Newest seeded block: 1 = the old long paste, 2 = the stable layer. */
  layout?: number;
  chars?: number;
  /** ISO date of the newest session; with "none", the one that had no block. */
  newest?: string;
  /** ISO date of the oldest consecutive session carrying the same block. */
  unchangedSince?: string;
  /** Voice corrections carried by that block, counted under their own heading. */
  corrections?: number;
}

const MAX_COMPARED = 50;

// One Cowork session as it sits on disk: <root>/<account>/<org>/<session>/,
// with the instructions it was seeded with in .claude/CLAUDE.md. Older Claude
// Desktop builds named the session directory local_<uuid>; newer ones use a
// short hex id and mostly write no CLAUDE.md at all, or an empty one.
interface Session {
  /** The seeded instructions file, or null when the session has none. */
  file: string | null;
  /** When it was seeded: the file's mtime, else the .claude directory's. */
  at: number;
}

// The newest session decides. Skipping past sessions whose file was empty or
// missing, as this used to, reported a block from weeks earlier as "the last
// session" whenever the newest few had nothing in them, and doctor then asked
// for a re-paste on the strength of it. A session without a block says nothing
// about the field, so the answer for it is "none", not an older session's.
export async function probeCoworkSession(roots: string[] = coworkSessionRoots()): Promise<CoworkProbe> {
  try {
    const sessions: Session[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      sessions.push(...(await listSessions(root)));
    }
    if (sessions.length === 0) return { status: "none" };
    sessions.sort((a, b) => b.at - a.at);

    const newest = sessions[0]!;
    const body = newest.file ? extractBlock(await readFile(newest.file, "utf8").catch(() => "")) : null;
    if (body === null) return { status: "none", newest: day(newest.at) };
    const hash = createHash("sha1").update(body).digest("hex");

    // Walk back while the block is identical, to report a range rather than a
    // single date: "unchanged since" is the number that shows the drift. A
    // session with no block is skipped, since it shows nothing either way; a
    // different block ends the run.
    let unchangedSince = newest.at;
    let compared = 0;
    for (const s of sessions.slice(1)) {
      if (!s.file) continue;
      if (++compared > MAX_COMPARED) break;
      const other = extractBlock(await readFile(s.file, "utf8").catch(() => ""));
      if (other === null) continue;
      if (createHash("sha1").update(other).digest("hex") !== hash) break;
      unchangedSince = s.at;
    }

    return {
      status: "found",
      layout: classify(body),
      chars: body.length,
      newest: day(newest.at),
      unchangedSince: day(unchangedSince),
      corrections: countCorrections(body),
    };
  } catch {
    return { status: "unreadable" };
  }
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Three fixed levels of directories, then a stat or two per session. This used
// to walk six levels of everything under the root looking for CLAUDE.md: on one
// machine about 14,000 directories of plugin caches, uploads and outputs, half
// a second of every server boot, against a 20,000-directory cap that a few more
// weeks of sessions would have hit, cutting the walk wherever readdir order put
// the cut.
async function listSessions(root: string): Promise<Session[]> {
  const out: Session[] = [];
  for (const account of await subdirs(root)) {
    for (const org of await subdirs(account)) {
      const found = await Promise.all((await subdirs(org)).map((dir) => sessionAt(dir)));
      for (const s of found) if (s) out.push(s);
    }
  }
  return out;
}

async function sessionAt(dir: string): Promise<Session | null> {
  const claudeDir = join(dir, ".claude");
  const file = join(claudeDir, "CLAUDE.md");
  const st = await stat(file).catch(() => null);
  if (st?.isFile()) return { file, at: st.mtimeMs };
  // Only a directory with a .claude inside is a session; the same level holds
  // caches and settings directories that are not.
  const dirSt = await stat(claudeDir).catch(() => null);
  return dirSt?.isDirectory() ? { file: null, at: dirSt.mtimeMs } : null;
}

// Not followed: a symlink loop under a directory nobody documents should not be
// able to hang a server boot.
async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => join(dir, e.name));
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
