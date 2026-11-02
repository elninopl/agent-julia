import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { configPath } from "../config/config.js";

// Secrets live next to the config they belong to, never in it: one directory
// per persona process, readable by its owner only.
export function secretsDir(): string {
  return join(dirname(configPath()), "secrets");
}

export function tokensFile(): string {
  return join(secretsDir(), "tokens.json");
}

// The name a token scope uses for the primary store (memoryDir). Store names
// cannot take it.
export const PRIMARY_SCOPE = "primary";

export interface TokenRecord {
  id: string;
  name: string;
  // sha256 of the token. The token itself is shown once, when it is made.
  hash: string;
  // Stores this token may reach, "primary" included by name. Absent: all.
  stores?: string[];
  createdAt: string;
}

interface TokenFile {
  tokens: TokenRecord[];
}

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

export async function writeSecretFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // pid alone is not unique: one process saves the OAuth state from
  // concurrent requests.
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function readTokens(file = tokensFile()): Promise<TokenRecord[]> {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<TokenFile>;
  return Array.isArray(parsed.tokens) ? parsed.tokens : [];
}

async function writeTokens(tokens: TokenRecord[], file = tokensFile()): Promise<void> {
  await writeSecretFile(file, JSON.stringify({ tokens }, null, 2) + "\n");
}

export async function addToken(
  name: string,
  stores?: string[],
  file = tokensFile(),
): Promise<{ token: string; record: TokenRecord }> {
  const clean = name.trim();
  if (!clean) throw new Error("a token needs a name, e.g. the client it is for");
  const tokens = await readTokens(file);
  if (tokens.some((t) => t.name === clean)) throw new Error(`a token named "${clean}" exists; revoke it first`);
  const token = `aj_${randomBytes(32).toString("base64url")}`;
  const record: TokenRecord = {
    id: randomUUID(),
    name: clean,
    hash: hashOf(token),
    ...(stores && stores.length > 0 ? { stores: [...new Set(stores)] } : {}),
    createdAt: new Date().toISOString(),
  };
  await writeTokens([...tokens, record], file);
  return { token, record };
}

export async function revokeToken(nameOrId: string, file = tokensFile()): Promise<boolean> {
  const tokens = await readTokens(file);
  const kept = tokens.filter((t) => t.name !== nameOrId && t.id !== nameOrId);
  if (kept.length === tokens.length) return false;
  await writeTokens(kept, file);
  return true;
}

// Checks a presented token against the hashed list. The file is read again
// when it changes, so a token added or revoked from the CLI applies to the
// running server without a restart.
export class StaticTokenVerifier implements OAuthTokenVerifier {
  private cache: { mtimeMs: number; tokens: TokenRecord[] } | null = null;

  // `resource`: the URL these tokens are good for. Set when the server also
  // speaks OAuth, whose middleware checks every token against its resource.
  constructor(
    private readonly file = tokensFile(),
    private readonly resource?: URL,
  ) {}

  private async current(): Promise<TokenRecord[]> {
    const mtimeMs = await stat(this.file).then((s) => s.mtimeMs, () => -1);
    if (!this.cache || this.cache.mtimeMs !== mtimeMs) {
      this.cache = { mtimeMs, tokens: mtimeMs < 0 ? [] : await readTokens(this.file) };
    }
    return this.cache.tokens;
  }

  async find(token: string): Promise<TokenRecord | null> {
    const presented = Buffer.from(hashOf(token), "hex");
    let found: TokenRecord | null = null;
    // Every record is compared, matched or not, so the time taken says
    // nothing about which one matched.
    for (const t of await this.current()) {
      const stored = Buffer.from(t.hash, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) found = t;
    }
    return found;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.find(token);
    if (!record) throw new InvalidTokenError("Invalid token");
    return {
      token,
      clientId: `token:${record.id}`,
      scopes: [],
      // These tokens do not expire; the middleware wants a time all the same.
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { name: record.name, ...(record.stores ? { stores: record.stores } : {}) },
      ...(this.resource ? { resource: this.resource } : {}),
    };
  }
}
