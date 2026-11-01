import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConfigSchema, ServerConfig } from "../src/config/schema.js";
import { migrate } from "../src/migrations/runner.js";
import { storePaths } from "../src/store/paths.js";
import { Indexer } from "../src/index/indexer.js";
import { ServerState, listenHttp, refuseSettings } from "../src/http/serve-http.js";
import { StaticTokenVerifier, addToken } from "../src/http/tokens.js";
import { OwnerOAuthProvider, listOAuthClients, revokeOAuthClients } from "../src/http/oauth.js";
import { checkOwnerPassword, setOwnerPassword } from "../src/http/owner.js";
import type { Runtime } from "../src/runtime.js";

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = "correct horse battery";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function serve(opts: { owner?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aj-oauth-store-"));
  const config = ConfigSchema.parse({ memoryDir: dir, git: false, search: "fts" });
  await migrate(config, { persistConfig: false });
  const paths = storePaths(dir);
  const indexer = Indexer.open(paths, config);
  const rt: Runtime = { config, paths, indexer };

  const secrets = mkdtempSync(join(tmpdir(), "aj-oauth-secrets-"));
  const files = {
    oauth: join(secrets, "oauth.json"),
    owner: join(secrets, "owner.json"),
    tokens: join(secrets, "tokens.json"),
  };
  if (opts.owner !== false) await setOwnerPassword(PASSWORD, files.owner);

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const resource = new URL(`${origin}/mcp`);
  const settings: ServerConfig = { host: "127.0.0.1", port, auth: "oauth", publicUrl: origin, maintenanceEveryMinutes: 60 };
  const provider = new OwnerOAuthProvider({ resource, displayName: "Julia", file: files.oauth, ownerFile: files.owner });
  const handle = await listenHttp(rt, settings, new ServerState(), {
    oauth: provider,
    verifier: new StaticTokenVerifier(files.tokens, resource),
  });
  cleanup.push(async () => {
    await handle.close();
    indexer.close();
  });
  return { origin, resource, files, provider };
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(origin: string): Promise<string> {
  const res = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function openConsent(origin: string, clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const url = new URL(`${origin}/authorize`);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: `${origin}/mcp`,
    ...extra,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, { redirect: "manual" });
}

const requestId = (html: string) => /name="request" value="([^"]+)"/.exec(html)![1]!;

const consent = (origin: string, fields: Record<string, string>) =>
  fetch(`${origin}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
    redirect: "manual",
  });

const token = (origin: string, fields: Record<string, string>) =>
  fetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
  });

// The whole claude.ai path: register, consent, code, tokens.
async function authorize(origin: string) {
  const clientId = await register(origin);
  const { verifier, challenge } = pkce();
  const page = await openConsent(origin, clientId, challenge);
  const id = requestId(await page.text());
  const allowed = await consent(origin, { request: id, password: PASSWORD, action: "allow" });
  const back = new URL(allowed.headers.get("location")!);
  const code = back.searchParams.get("code")!;
  const res = await token(origin, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: CALLBACK,
    resource: `${origin}/mcp`,
  });
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
  return { clientId, tokens };
}

async function connect(origin: string, accessToken: string): Promise<Client> {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  cleanup.push(() => client.close());
  return client;
}

describe("OAuth for claude.ai", () => {
  it("points an unauthenticated client at its metadata", async () => {
    const { origin } = await serve();
    const res = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );

    const prm = (await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(prm.resource).toBe(`${origin}/mcp`);
    expect(prm.authorization_servers.map((s) => s.replace(/\/$/, ""))).toEqual([origin]);

    const as = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    expect(as.registration_endpoint).toBe(`${origin}/register`);
    expect(as).not.toHaveProperty("client_id_metadata_document_supported");
  });

  it("lets a client in only after the owner's password, then serves MCP with the token", async () => {
    const { origin } = await serve();
    const clientId = await register(origin);
    const { verifier, challenge } = pkce();

    const page = await openConsent(origin, clientId, challenge);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain("Claude");
    expect(html).toContain("claude.ai");
    const id = requestId(html);

    const wrong = await consent(origin, { request: id, password: "not the password", action: "allow" });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Wrong password");

    const ok = await consent(origin, { request: id, password: PASSWORD, action: "allow" });
    expect(ok.status).toBe(302);
    const back = new URL(ok.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("st-1");
    const code = back.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // The consent page cannot be submitted twice.
    expect((await consent(origin, { request: id, password: PASSWORD, action: "allow" })).status).toBe(400);

    const bad = await token(origin, {
      grant_type: "authorization_code",
      code,
      code_verifier: pkce().verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");

    const res = await token(origin, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
      resource: `${origin}/mcp`,
    });
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.access_token).toMatch(/^ajo_/);

    // A code works once.
    const again = await token(origin, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
    });
    expect(again.status).toBe(400);

    const client = await connect(origin, tokens.access_token);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("search");
  });

  it("rotates refresh tokens and refuses a spent one", async () => {
    const { origin } = await serve();
    const { clientId, tokens } = await authorize(origin);
    const first = await token(origin, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(first.status).toBe(200);
    const next = (await first.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);

    const spent = await token(origin, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(spent.status).toBe(400);
    expect(((await spent.json()) as { error: string }).error).toBe("invalid_grant");

    const client = await connect(origin, next.access_token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("sends a refusal back to the app when the owner denies", async () => {
    const { origin } = await serve();
    const clientId = await register(origin);
    const page = await openConsent(origin, clientId, pkce().challenge);
    const denied = await consent(origin, { request: requestId(await page.text()), action: "deny" });
    expect(denied.status).toBe(302);
    const back = new URL(denied.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.has("code")).toBe(false);
  });

  it("refuses a request for another server's resource", async () => {
    const { origin } = await serve();
    const clientId = await register(origin);
    const res = await openConsent(origin, clientId, pkce().challenge, { resource: "https://elsewhere.example/mcp" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("says what to do when no owner password is set", async () => {
    const { origin } = await serve({ owner: false });
    const clientId = await register(origin);
    const res = await openConsent(origin, clientId, pkce().challenge);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("agent-julia server set-owner");
  });

  it("keeps clients and tokens across a restart, and lets the CLI cut a client off", async () => {
    const { origin, resource, files, provider } = await serve();
    const { clientId, tokens } = await authorize(origin);

    const reborn = new OwnerOAuthProvider({ resource, displayName: "Julia", file: files.oauth, ownerFile: files.owner });
    expect((await reborn.verifyAccessToken(tokens.access_token)).clientId).toBe(clientId);
    expect(JSON.stringify(listOAuthClients(files.oauth))).not.toContain(tokens.access_token);
    expect(listOAuthClients(files.oauth)).toMatchObject([{ id: clientId, name: "Claude", grants: 1 }]);

    expect(await revokeOAuthClients(clientId.slice(0, 8), files.oauth)).toBe(1);
    // Different mtime resolution across file systems: make sure the change is seen.
    await new Promise((r) => setTimeout(r, 20));
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    const res = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("still takes static bearer tokens next to OAuth", async () => {
    const { origin, files } = await serve();
    const { token: t } = await addToken("laptop", undefined, files.tokens);
    const client = await connect(origin, t);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("refuses OAuth settings that cannot work", () => {
    const base: ServerConfig = { host: "127.0.0.1", port: 0, auth: "oauth", maintenanceEveryMinutes: 60 };
    expect(refuseSettings(base)).toMatch(/publicUrl is not set/);
    expect(refuseSettings({ ...base, publicUrl: "http://julia.example.com" })).toMatch(/https/);
    expect(refuseSettings({ ...base, publicUrl: "https://example.com/julia" })).toMatch(/no path/);
    expect(refuseSettings({ ...base, publicUrl: "https://julia.example.com" })).toBeNull();
  });

  it("hashes the owner password and checks it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "aj-owner-")), "owner.json");
    await expect(setOwnerPassword("short", file)).rejects.toThrow(/12/);
    await setOwnerPassword(PASSWORD, file);
    expect(await checkOwnerPassword(PASSWORD, file)).toBe(true);
    expect(await checkOwnerPassword(`${PASSWORD}!`, file)).toBe(false);
  });
});
