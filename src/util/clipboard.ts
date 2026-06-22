import { spawn } from "node:child_process";
import { platform } from "node:os";

// Copy text to the system clipboard, best-effort. Returns false (never throws) on
// any platform without a usable clipboard tool — the caller falls back to telling
// the user where the file is. Linux tries Wayland then X11 helpers.
export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<[string, string[]]> =
    platform() === "darwin"
      ? [["pbcopy", []]]
      : platform() === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];

  for (const [cmd, args] of candidates) {
    if (await tryCopy(cmd, args, text)) return true;
  }
  return false;
}

function tryCopy(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false)); // command not installed, etc.
      child.on("close", (code) => resolve(code === 0));
      child.stdin.on("error", () => resolve(false));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}
