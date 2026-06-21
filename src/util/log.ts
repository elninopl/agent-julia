// Logging. The MCP server speaks JSON-RPC over stdout, so every diagnostic line
// MUST go to stderr to avoid corrupting the protocol stream.
export function log(...args: unknown[]): void {
  console.error("[agent-julia]", ...args);
}

export function warn(...args: unknown[]): void {
  console.error("[agent-julia][warn]", ...args);
}

export function logError(...args: unknown[]): void {
  console.error("[agent-julia][error]", ...args);
}
