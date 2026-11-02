import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// How long a session may go on reading without saving anything before it is
// asked once whether something is worth keeping, and how many reads it takes.
export const NUDGE_AFTER_MS = 20 * 60 * 1000;
const NUDGE_MIN_READS = 3;

const READS = new Set(["search", "read", "list", "related", "history"]);
const SAVES = new Set(["ingest", "correct_voice"]);

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };

// The server-side reminder (capture.serverNudge), for surfaces that run no
// hooks: claude.ai, the mobile app, Desktop. One per session, per interval.
export class SaveNudge {
  private lastSaveAt: number;
  private lastNudgeAt = Number.NEGATIVE_INFINITY;
  private reads = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.lastSaveAt = now();
  }

  after<T extends Result>(tool: string, result: T): T {
    if (result.isError) return result;
    const t = this.now();
    if (SAVES.has(tool)) {
      this.lastSaveAt = t;
      this.reads = 0;
      return result;
    }
    if (!READS.has(tool)) return result;
    this.reads++;
    if (this.reads < NUDGE_MIN_READS || t - this.lastSaveAt < NUDGE_AFTER_MS || t - this.lastNudgeAt < NUDGE_AFTER_MS) {
      return result;
    }
    this.lastNudgeAt = t;
    const minutes = Math.round((t - this.lastSaveAt) / 60_000);
    // A second content item, so a result that is JSON stays JSON.
    return {
      ...result,
      content: [
        ...result.content,
        {
          type: "text",
          text:
            `agent-julia: nothing saved in this session for ${minutes} min. ` +
            "If a decision, fact or preference worth keeping came up, ingest it.",
        },
      ],
    };
  }
}

// server.registerTool, with every result passed through the nudge.
export function nudging(server: McpServer, nudge: SaveNudge | null): McpServer["registerTool"] {
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) => unknown;
  if (!nudge) return register as unknown as McpServer["registerTool"];
  return ((name: string, config: unknown, cb: (...args: unknown[]) => unknown) =>
    register(name, config, async (...args: unknown[]) => nudge.after(name, (await cb(...args)) as Result))) as unknown as McpServer["registerTool"];
}
