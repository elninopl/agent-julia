// Logging. The MCP server speaks JSON-RPC over stdout, so every diagnostic line
// MUST go to stderr to avoid corrupting the protocol stream.
//
// The interactive wizard sets quiet mode so its own polished output isn't
// interleaved with internal info logs (warnings and errors still come through).
let quiet = false;
export function setQuiet(value: boolean): void {
  quiet = value;
}

export function log(...args: unknown[]): void {
  if (quiet) return;
  console.error("[agent-julia]", ...args);
}

export function warn(...args: unknown[]): void {
  console.error("[agent-julia][warn]", ...args);
}

export function logError(...args: unknown[]): void {
  console.error("[agent-julia][error]", ...args);
}
