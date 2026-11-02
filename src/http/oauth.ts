import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Request, RequestHandler, Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { secretsDir, writeSecretFile } from "./tokens.js";
import { checkOwnerPassword, ownerFile, ownerIsSet } from "./owner.js";
import { warn } from "../util/log.js";

export function oauthFile(): string {
  return join(secretsDir(), "oauth.json");
}

const ACCESS_TTL_S = 60 * 60;
// A refresh token not used for this long is gone; each use issues a new one.
const REFRESH_IDLE_S = 90 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 100;
// A registered client that never got a token is dropped after this long:
// dynamic registration makes a new client on every fresh connection.
const UNUSED_CLIENT_MS = 24 * 60 * 60 * 1000;
// Wrong owner passwords, across all requests, before consent stops answering.
// A stranger can use them up and hold off a new connection for the window;
// connections already made keep working.
const MAX_FAILURES = 10;
const MAX_ATTEMPTS_PER_REQUEST = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

interface StoredClient extends OAuthClientInformationFull {
  last_used_at?: number;
}

interface StoredToken {
  hash: string;
  clientId: string;
  expiresAt: number; // seconds
  scopes: string[];
  resource: string;
}

interface OAuthState {
  clients: StoredClient[];
  access: StoredToken[];
  refresh: StoredToken[];
}

interface PendingConsent {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
  attempts: number;
  checking?: boolean;
}

interface IssuedCode {
  clientId: string;
  challenge: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
}

// Throws when the file is there but cannot be read: callers must not take
// that for "no clients" and write the emptiness over it.
function readOAuthState(file: string): OAuthState {
  if (!existsSync(file)) return { clients: [], access: [], refresh: [] };
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<OAuthState>;
  return { clients: raw.clients ?? [], access: raw.access ?? [], refresh: raw.refresh ?? [] };
}

async function writeOAuthState(state: OAuthState, file: string): Promise<void> {
  await writeSecretFile(file, JSON.stringify(state, null, 2) + "\n");
}

export interface OAuthClientSummary {
  id: string;
  name: string;
  registeredAt: string;
  lastUsedAt: string | null;
  // Refresh tokens still valid: how many devices or sessions hold access.
  grants: number;
}

// For `agent-julia server oauth list`.
export function listOAuthClients(file = oauthFile()): OAuthClientSummary[] {
  const state = readOAuthState(file);
  const now = Math.floor(Date.now() / 1000);
  return state.clients.map((c) => ({
    id: c.client_id,
    name: c.client_name ?? "(unnamed)",
    registeredAt: new Date((c.client_id_issued_at ?? 0) * 1000).toISOString(),
    lastUsedAt: c.last_used_at ? new Date(c.last_used_at * 1000).toISOString() : null,
    grants: state.refresh.filter((t) => t.clientId === c.client_id && t.expiresAt > now).length,
  }));
}

// Forget a client and every token it holds; "all" forgets every client. The
// client has to go through consent again to come back.
export async function revokeOAuthClients(which: string, file = oauthFile()): Promise<number> {
  const state = readOAuthState(file);
  const gone = new Set(
    state.clients.filter((c) => which === "all" || c.client_id === which || c.client_id.startsWith(which)).map((c) => c.client_id),
  );
  if (which !== "all" && gone.size > 1) throw new Error(`"${which}" matches ${gone.size} clients; give more of the id`);
  if (gone.size === 0) return 0;
  await writeOAuthState(
    {
      clients: state.clients.filter((c) => !gone.has(c.client_id)),
      access: state.access.filter((t) => !gone.has(t.clientId)),
      refresh: state.refresh.filter((t) => !gone.has(t.clientId)),
    },
    file,
  );
  return gone.size;
}

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const nowS = (): number => Math.floor(Date.now() / 1000);
const canonical = (u: URL | string): string => {
  const s = String(u);
  const hash = s.indexOf("#");
  return (hash === -1 ? s : s.slice(0, hash)).replace(/\/$/, "");
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The authorisation server of a single-owner agent-julia: anyone may register
// a client, only the owner can let one in. Clients and tokens (as hashes) are
// kept in secrets/oauth.json, so a restart logs nobody out; codes and pending
// consents live in memory for minutes.
export class OwnerOAuthProvider implements OAuthServerProvider {
  private state: OAuthState = { clients: [], access: [], refresh: [] };
  private loadedMtime = -2;
  private readonly pending = new Map<string, PendingConsent>();
  private readonly codes = new Map<string, IssuedCode>();
  private failures: number[] = [];
  // One scrypt at a time: parallel guesses would otherwise all run at once
  // and take every thread that file I/O needs.
  private checking: Promise<unknown> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  // Saves queued or running. While one is, the file on disk is this
  // process's own, older than what is in memory: not to be read back.
  private unsaved = 0;

  constructor(
    private readonly opts: {
      resource: URL;
      displayName: string;
      file?: string;
      ownerFile?: string;
    },
  ) {
    this.sync();
  }

  private get file(): string {
    return this.opts.file ?? oauthFile();
  }

  private get owner(): string {
    return this.opts.ownerFile ?? ownerFile();
  }

  private mtime(): number {
    try {
      return statSync(this.file).mtimeMs;
    } catch {
      return -1;
    }
  }

  // Read the file again when someone else changed it: `server oauth revoke`
  // run while the server is up takes effect on the next request. A file that
  // does not parse keeps what is in memory, and a copy of it is set aside
  // before the next save writes over it.
  private sync(): void {
    if (this.unsaved > 0) return;
    const mtime = this.mtime();
    if (mtime === this.loadedMtime) return;
    try {
      this.state = readOAuthState(this.file);
    } catch (err) {
      const copy = `${this.file}.unreadable`;
      try {
        copyFileSync(this.file, copy);
      } catch {
        // nothing to keep
      }
      warn(`could not read ${this.file} (${(err as Error).message}); kept a copy at ${copy}`);
    }
    this.loadedMtime = mtime;
  }

  // Saves run one after another: each writes the state as it is by then.
  private save(): Promise<void> {
    this.unsaved++;
    const run = this.saving.then(async () => {
      const now = nowS();
      const cutoff = Date.now() - UNUSED_CLIENT_MS;
      this.state = {
        clients: this.state.clients.filter((c) => c.last_used_at || (c.client_id_issued_at ?? 0) * 1000 > cutoff),
        access: this.state.access.filter((t) => t.expiresAt > now),
        refresh: this.state.refresh.filter((t) => t.expiresAt > now),
      };
      try {
        await writeOAuthState(this.state, this.file);
        this.loadedMtime = this.mtime();
      } finally {
        this.unsaved--;
      }
    });
    this.saving = run.catch(() => undefined);
    return run;
  }

  private checkPassword(password: string): Promise<boolean> {
    const run = this.checking.then(() => checkOwnerPassword(password, this.owner));
    this.checking = run.catch(() => undefined);
    return run;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id: string) => {
        this.sync();
        return this.state.clients.find((c) => c.client_id === id);
      },
      registerClient: async (client) => {
        this.sync();
        // The SDK's handler has already named the client; the fallback is for
        // a caller that leaves it to the store.
        const given = client as Partial<OAuthClientInformationFull>;
        const full = {
          ...client,
          client_id: given.client_id || randomUUID(),
          client_id_issued_at: given.client_id_issued_at ?? nowS(),
        } as StoredClient;
        this.state.clients.push(full);
        await this.save();
        return full;
      },
    };
  }

  private checkResource(resource: URL | undefined): void {
    if (resource && canonical(resource) !== canonical(this.opts.resource)) {
      throw new InvalidTargetError(`this server is ${canonical(this.opts.resource)}`);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    if (!ownerIsSet(this.owner)) {
      this.page(res, 503, "Not ready", "<p>No owner password is set on this server yet. Run <code>agent-julia server set-owner</code> on it, then connect again.</p>", params.redirectUri);
      return;
    }
    const now = Date.now();
    for (const [id, p] of this.pending) if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(id);
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const id = randomBytes(24).toString("base64url");
    this.pending.set(id, { client, params, createdAt: now, attempts: 0 });
    this.consentPage(res, id, client, params.redirectUri);
  }

  private consentPage(res: Response, id: string, client: OAuthClientInformationFull, redirectUri: string, error?: string): void {
    const who = escapeHtml(client.client_name ?? "An application");
    const where = escapeHtml(new URL(redirectUri).host);
    this.page(
      res,
      error ? 401 : 200,
      `Connect to ${this.opts.displayName}`,
      `<p><strong>${who}</strong> (${where}) asks to read and write this memory.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/consent">
  <input type="hidden" name="request" value="${escapeHtml(id)}">
  <label>Owner password <input type="password" name="password" autocomplete="current-password" autofocus></label>
  <div class="row"><button name="action" value="allow">Allow</button><button name="action" value="deny" class="quiet">Deny</button></div>
</form>`,
      redirectUri,
    );
  }

  private page(res: Response, status: number, title: string, body: string, redirectUri?: string): void {
    const formTargets = ["'self'", ...(redirectUri ? [new URL(redirectUri).origin] : [])].join(" ");
    res
      .status(status)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formTargets}; frame-ancestors 'none'`,
      })
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#f2f2f2;background:#161616}input{background:#222;color:#f2f2f2;border-color:#444}}
input{display:block;width:100%;box-sizing:border-box;margin:.4rem 0 1rem;padding:.6rem;font:inherit;border:1px solid #bbb;border-radius:6px}
.row{display:flex;gap:.6rem}button{font:inherit;padding:.5rem 1.1rem;border-radius:6px;border:1px solid #1d1d1f;background:#1d1d1f;color:#fff;cursor:pointer}
button.quiet{background:transparent;color:inherit;border-color:#999}.err{color:#c62828}code{font-size:.9em}
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
  }

  // POST /oauth/consent, from the page above.
  consentHandler(): RequestHandler {
    return async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, string>;
      const pending = this.pending.get(String(body.request ?? ""));
      if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
        this.page(res, 400, "Expired", "<p>This request has expired. Start the connection again from the app.</p>");
        return;
      }
      const { params, client } = pending;
      const back = new URL(params.redirectUri);
      if (params.state !== undefined) back.searchParams.set("state", params.state);

      if (body.action !== "allow") {
        this.pending.delete(String(body.request));
        back.searchParams.set("error", "access_denied");
        res.redirect(302, back.href);
        return;
      }

      const now = Date.now();
      this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
      if (this.failures.length >= MAX_FAILURES) {
        this.page(res, 429, "Too many attempts", "<p>Too many wrong passwords. Try again in a quarter of an hour.</p>");
        return;
      }
      // One check at a time per request, and the failure counted before the
      // slow check, so guesses sent in parallel cannot get past the limits.
      // The right password takes it back.
      const id = String(body.request);
      if (pending.checking) {
        this.page(res, 429, "Too many attempts", "<p>A password for this request is being checked already.</p>");
        return;
      }
      const slot = now;
      this.failures.push(slot);
      pending.checking = true;
      let ok = false;
      try {
        ok = await this.checkPassword(String(body.password ?? ""));
      } finally {
        pending.checking = false;
      }
      if (!ok) {
        pending.attempts++;
        if (pending.attempts < MAX_ATTEMPTS_PER_REQUEST) {
          this.consentPage(res, id, client, params.redirectUri, "Wrong password.");
        } else {
          this.pending.delete(id);
          this.page(res, 401, "Too many attempts", "<p>Too many wrong passwords for this request. Start the connection again from the app.</p>");
        }
        return;
      }
      const i = this.failures.indexOf(slot);
      if (i >= 0) this.failures.splice(i, 1);
      // Denied or dropped while the password was being checked.
      if (this.pending.get(id) !== pending) {
        this.page(res, 400, "Expired", "<p>This request has expired. Start the connection again from the app.</p>");
        return;
      }

      this.pending.delete(String(body.request));
      const code = randomBytes(32).toString("base64url");
      this.codes.set(code, {
        clientId: client.client_id,
        challenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        resource: canonical(params.resource ?? this.opts.resource),
        scopes: params.scopes ?? [],
        expiresAt: now + CODE_TTL_MS,
      });
      back.searchParams.set("code", code);
      res.redirect(302, back.href);
    };
  }

  private liveCode(client: OAuthClientInformationFull, code: string): IssuedCode {
    const entry = this.codes.get(code);
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError("unknown or expired authorization code");
    }
    return entry;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.liveCode(client, code).challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.liveCode(client, code);
    this.codes.delete(code);
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    this.checkResource(resource);
    return this.issue(client.client_id, entry.scopes, entry.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.checkResource(resource);
    this.sync();
    const hash = hashOf(refreshToken);
    const found = this.state.refresh.find((t) => t.hash === hash);
    if (!found || found.clientId !== client.client_id || found.expiresAt <= nowS()) {
      throw new InvalidGrantError("unknown or expired refresh token");
    }
    // Rotation: the token just used is spent, unless the new ones could not
    // be saved; then the client still holds a token that works.
    this.state.refresh = this.state.refresh.filter((t) => t !== found);
    try {
      return await this.issue(client.client_id, found.scopes, found.resource);
    } catch (err) {
      this.state.refresh.push(found);
      throw err;
    }
  }

  private async issue(clientId: string, scopes: string[], resource: string): Promise<OAuthTokens> {
    const access = `ajo_${randomBytes(32).toString("base64url")}`;
    const refresh = `ajr_${randomBytes(32).toString("base64url")}`;
    const now = nowS();
    this.state.access.push({ hash: hashOf(access), clientId, expiresAt: now + ACCESS_TTL_S, scopes, resource });
    this.state.refresh.push({ hash: hashOf(refresh), clientId, expiresAt: now + REFRESH_IDLE_S, scopes, resource });
    const client = this.state.clients.find((c) => c.client_id === clientId);
    if (client) client.last_used_at = now;
    await this.save();
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.sync();
    const hash = hashOf(token);
    const found = this.state.access.find((t) => t.hash === hash);
    if (!found || found.expiresAt <= nowS()) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: found.clientId,
      scopes: found.scopes,
      expiresAt: found.expiresAt,
      resource: new URL(found.resource),
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.sync();
    const hash = hashOf(request.token);
    const keep = (t: StoredToken) => !(t.hash === hash && t.clientId === client.client_id);
    this.state.access = this.state.access.filter(keep);
    this.state.refresh = this.state.refresh.filter(keep);
    await this.save();
  }
}
