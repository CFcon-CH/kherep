// Confluence broker transport: credential read, token, cloudId and the ONE
// authenticated request path. Nothing about content lives here.
//
// WHY THIS FILE SITS IN A DIRECTORY NAMED AFTER JIRA, and why that is not a bug
// to fix: bootstrap/install.sh and codex/install.mts copy this directory FLAT
// into <workspace>/tools/, so every relative import has to stay
// "./something.mts". A modules/atl-confluence-brokers/ would have to import
// "../atl-jira-brokers/atlassian-credentials.mts", which resolves in the checkout and
// breaks in the installed workspace. Correctness beats the directory name.
//
// parseCredentialText is IMPORTED rather than reimplemented: it is security
// relevant, already exported and already tested. Keeping it runtime-neutral
// prevents this transport from importing either runtime's Jira broker.
import { parseCredentialText } from "./atlassian-credentials.mts";
import {
  ConfluenceError,
  requestError,
  v1,
  type ConfluenceResponse,
  type ConfluenceSession,
  type RequestSpec,
} from "./confluence-contract.mts";

const AUTH_URL = "https://auth.atlassian.com/oauth/token";
const API_BASE = "https://api.atlassian.com/ex/confluence";
const SITE_ENV = "KHEREP_ATL_SITE";
const TOKEN_SAFETY_MS = 60_000;

// Declared structurally, like the Jira broker's own: the tests hand over stubs
// answering exactly these members, and a wider type would force every stub to
// build a whole Response object.
export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

export type FetchLike = (url: string, options?: RequestOptions) => Promise<HttpResponse>;
export type ReadFileLike = (path: string, encoding: "utf8") => Promise<string>;

// Token and cloudId of ONE run. The cache hangs on the context a CLI builds per
// invocation, NEVER at module scope. A module-global cache would reopen the
// failure class that separate credential variables per runtime exist to
// prevent: a second run in the same process would silently keep the first run's
// token and write under the first run's identity, and every page it created
// would look perfectly correct. Nothing reaches disk either - a token file
// would be a new secret at a path no guard covers.
export interface SessionCache {
  token?: string;
  tokenExpiresAt?: number;
  cloudId?: string;
}

export interface ConfluenceContext {
  env: Record<string, string | undefined>;
  // The credential variable is a PARAMETER, never a constant of this file. Each
  // CLI passes its own runtime's variable. A transport that knows both names is
  // a transport that can write under the other runtime's identity.
  credEnv: string;
  readFile: ReadFileLike;
  fetch: FetchLike;
  now: () => number;
  session: SessionCache;
}

export function siteOrigin(env: Record<string, string | undefined>): string {
  const raw = env[SITE_ENV];
  if (!raw?.trim()) throw new ConfluenceError(`${SITE_ENV} is not set.`);
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { throw new ConfluenceError(`${SITE_ENV} is not a valid URL.`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ConfluenceError(`${SITE_ENV} must be a credential-free HTTPS origin.`);
  }
  return parsed.origin;
}

async function readCredentials(ctx: ConfluenceContext): Promise<{ clientId: string; clientSecret: string }> {
  const file = ctx.env[ctx.credEnv];
  if (!file?.trim()) throw new ConfluenceError(`${ctx.credEnv} is not set.`);
  let raw: string;
  try {
    raw = await ctx.readFile(file, "utf8");
  } catch {
    throw new ConfluenceError("Credential file is not readable."); // deliberately without the path
  }
  try {
    return parseCredentialText(raw);
  } catch {
    throw new ConfluenceError("Credential file does not carry both values.");
  }
}

interface TokenResult {
  status: number;
  token: string | null;
  error: string | null;
  expiresIn: number | null;
}

async function requestToken(
  ctx: ConfluenceContext,
  credentials: { clientId: string; clientSecret: string },
): Promise<TokenResult> {
  const response = await ctx.fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: Buffer.from(JSON.stringify({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      audience: "api.atlassian.com",
    }), "utf8"),
  });
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string; error?: string; expires_in?: number;
  };
  return {
    status: response.status,
    token: payload.access_token || null,
    error: payload.error || null,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : null,
  };
}

async function accessToken(ctx: ConfluenceContext): Promise<string> {
  const { token: cached, tokenExpiresAt } = ctx.session;
  if (cached && tokenExpiresAt !== undefined && tokenExpiresAt > ctx.now() + TOKEN_SAFETY_MS) return cached;
  const { status, token, error, expiresIn } = await requestToken(ctx, await readCredentials(ctx));
  // The status and the provider's error code are reported. The secret and the
  // token never are, here or anywhere below.
  if (!token) throw new ConfluenceError(`Token request failed: HTTP ${status}${error ? ` ${error}` : ""}`);
  // Without a usable expires_in nothing is cached. One request more beats an
  // expired token in a long-lived process.
  if (expiresIn !== null && expiresIn > 0) {
    ctx.session.token = token;
    ctx.session.tokenExpiresAt = ctx.now() + expiresIn * 1000;
  }
  return token;
}

// cloudId is not a secret: tenant_info is served without a header.
export async function cloudId(ctx: ConfluenceContext): Promise<string> {
  if (ctx.session.cloudId) return ctx.session.cloudId;
  const response = await ctx.fetch(`${siteOrigin(ctx.env)}/_edge/tenant_info`);
  if (!response.ok) throw new ConfluenceError(`tenant_info failed: HTTP ${response.status}`);
  const { cloudId: id } = await response.json() as { cloudId?: string };
  if (!id) throw new ConfluenceError("tenant_info returned no cloudId.");
  ctx.session.cloudId = id;
  return id;
}

export function createSession(ctx: ConfluenceContext): ConfluenceSession {
  return {
    async request(spec: RequestSpec): Promise<ConfluenceResponse> {
      const token = await accessToken(ctx);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      let body: Buffer | undefined;
      if (spec.body !== undefined) {
        body = Buffer.from(JSON.stringify(spec.body), "utf8");
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(body.length);
      }
      const response = await ctx.fetch(`${API_BASE}/${await cloudId(ctx)}${spec.path}`, {
        method: spec.method, headers, body,
      });
      const text = await response.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 204 and error pages */ }
      if (response.status < 200 || response.status >= 300) throw requestError(spec, response.status, json);
      return { status: response.status, json };
    },
  };
}

// Who the token belongs to, when the site is willing to say. selftest prints it
// as evidence of the identity a page would be created under, but must not
// depend on it: this read needs read:confluence-user, which a binding scoped to
// pages alone does not carry, and a selftest that fails for a MISSING optional
// scope would hide the credential result it exists to report.
export async function currentUser(
  session: ConfluenceSession,
): Promise<{ accountId: string; displayName: string } | null> {
  try {
    const { json } = await session.request({
      method: "GET",
      path: v1("/user/current"),
      scope: "read:confluence-user",
    });
    const user = (json ?? {}) as { accountId?: unknown; displayName?: unknown };
    const accountId = typeof user.accountId === "string" ? user.accountId : "";
    if (!accountId) return null;
    return { accountId, displayName: typeof user.displayName === "string" ? user.displayName : "" };
  } catch {
    return null;
  }
}

// The scopes a token carries, read from its own payload. A scope name is a
// permission label, not a secret, and without it every 403 and every 401 that
// says "scope does not match" is a guessing game about which grant is missing.
// Failure returns an empty list: an undecodable token is a reason to say
// nothing, never a reason to claim the binding has no scopes.
export function tokenScopes(token: string): string[] {
  const payload = token.split(".")[1];
  if (!payload) return [];
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { scope?: unknown };
    return typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean).sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }) : [];
  } catch { return []; }
}

// The control run behind the selftest verb. A check that answers the same with
// right and with wrong credentials does not discriminate and proves nothing, so
// the secret is tampered with HERE and never leaves the process. Reports the
// token LENGTH and the token's SCOPES, never the token.
export async function authenticationReport(ctx: ConfluenceContext): Promise<{ lines: string[]; ok: boolean }> {
  const credentials = await readCredentials(ctx);
  const good = await requestToken(ctx, credentials);
  const bad = await requestToken(ctx, {
    clientId: credentials.clientId,
    clientSecret: `${credentials.clientSecret.slice(0, -4)}XXXX`,
  });
  const lines = [
    `genuine: status ${good.status}${good.error ? ` ${good.error}` : ""}, token ${good.token ? `length ${good.token.length}` : "none"}`,
    `tampered: status ${bad.status}${bad.error ? ` ${bad.error}` : ""}, token ${bad.token ? "RECEIVED" : "none"}`,
  ];
  const scopes = good.token ? tokenScopes(good.token) : [];
  lines.push(scopes.length
    ? `scopes: ${scopes.join(" ")}`
    : "scopes: not readable from the token - this says nothing about which grants exist");
  const ok = good.status === 200 && !!good.token && bad.status === 401 && !bad.token;
  // OP-1415. Not discriminating has two very different causes. The SAME answer
  // to both means the check cannot tell them apart and nothing is known, which
  // is what a rotated or revoked secret looks like. DIFFERENT answers mean the
  // endpoint can tell them apart and refused the genuine one: a proven no.
  const same = good.status === bad.status && good.error === bad.error && !!good.token === !!bad.token;
  lines.push(`verdict: ${ok ? "PASS"
    : same ? "UNKNOWN - the check does not discriminate"
      : "FAIL - the genuine secret was refused"}`);
  return { lines, ok };
}
