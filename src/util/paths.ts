import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

// Expand a leading ~ and resolve to an absolute path.
export function expandPath(p: string): string {
  let out = p;
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = resolve(homedir(), out.slice(2));
  return isAbsolute(out) ? out : resolve(process.cwd(), out);
}
