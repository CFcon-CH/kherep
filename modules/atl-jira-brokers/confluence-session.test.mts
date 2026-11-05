// Transport tests. Injected fetch, injected readFile, synthetic values only:
// nothing here reaches a network or a credential file on disk.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfluenceError,
  ConfluenceRequestError,
  SCOPES,
  v2,
} from "./confluence-contract.mts";
import {
  authenticationReport,
  createSession,
  currentUser,
  tokenScopes,
  type ConfluenceContext,
  type HttpResponse,
  type RequestOptions,
} from "./confluence-session.mts";

const CLIENT_ID = "client-id-for-tests";
const CLIENT_SECRET = "secret-for-tests-1234";
const ACCESS_TOKEN = "access-token-must-never-be-reported";
const CLOUD_ID = "cloud-id-for-tests";
const CRED_PATH = "/nowhere/credentials-for-tests";
const CRED_TEXT = `Client ID: ${CLIENT_ID}\nSecret: ${CLIENT_SECRET}\n`;
const SITE = "https://wiki.example.com";
const CLAUDE_ENV = "KHEREP_ATL_CRED_FILE_CLAUDE";
const CODEX_ENV = "KHEREP_ATL_CRED_FILE_CODEX";

interface Call {
  url: string;
  options?: RequestOptions;
}

function response(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body ?? {}; },
    async text() { return body === undefined ? "" : JSON.stringify(body); },
  };
}

interface Options {
  env?: Record<string, string | undefined>;
  credEnv?: string;
  api?: (call: Call) => HttpResponse;
  token?: (body: { client_id?: string; client_secret?: string }) => HttpResponse;
}

function harness(options: Options = {}) {
  const calls: Call[] = [];
  const ctx: ConfluenceContext = {
    env: options.env ?? { KHEREP_ATL_SITE: SITE, [CLAUDE_ENV]: CRED_PATH },
    credEnv: options.credEnv ?? CLAUDE_ENV,
    async readFile(path) {
      if (path !== CRED_PATH) throw new Error("no such file");
      return CRED_TEXT;
    },
    async fetch(url, requestOptions) {
      calls.push({ url, options: requestOptions });
      if (url.startsWith("https://auth.atlassian.com")) {
        const body = JSON.parse(String(requestOptions?.body ?? "{}")) as { client_secret?: string };
        return options.token
          ? options.token(body)
          : response(200, { access_token: ACCESS_TOKEN, expires_in: 3600 });
      }
      if (url.endsWith("/_edge/tenant_info")) return response(200, { cloudId: CLOUD_ID });
      return options.api ? options.api({ url, options: requestOptions }) : response(200, {});
    },
    now: () => 1_000_000,
    session: {},
  };
  const of = (fragment: string) => calls.filter((call) => call.url.includes(fragment));
  return { ctx, calls, of };
}

const GET_PAGE = { method: "GET", path: v2("/pages/1"), scope: SCOPES.get };

test("token scopes retain duplicates and UTF-16 order while dropping empty fields", () => {
  const scopes = ["write:page", "Read:page", "read:page", "write:page", "\ud800", "\ud83d\ude00"];
  const payload = Buffer.from(JSON.stringify({ scope: `  ${scopes.join("  ")}  ` })).toString("base64url");
  assert.deepEqual(tokenScopes(`header.${payload}.signature`), [...scopes].sort());
  for (const token of ["", "header..signature", "header.invalid.signature",
    `header.${Buffer.from(JSON.stringify({ scope: ["read:page"] })).toString("base64url")}.signature`]) {
    assert.deepEqual(tokenScopes(token), []);
  }
});

test("a 403 names the scope the attempted verb requires", async () => {
  const { ctx } = harness({ api: () => response(403, { errors: [{ title: "Current user not permitted" }] }) });
  await assert.rejects(
    () => createSession(ctx).request({ method: "POST", path: v2("/pages"), scope: SCOPES.create }),
    (error: unknown) => {
      assert.ok(error instanceof ConfluenceRequestError);
      assert.equal(error.kind, "forbidden");
      assert.equal(error.status, 403);
      assert.equal(error.method, "POST");
      assert.equal(error.path, "/wiki/api/v2/pages");
      assert.match(error.cliMessage, /write:page:confluence/);
      assert.match(error.cliMessage, /POST \/wiki\/api\/v2\/pages/);
      assert.match(error.cliMessage, /Current user not permitted/);
      return true;
    },
  );
});

test("a 413 is a size failure and does not read as a permission failure", async () => {
  const { ctx } = harness({ api: () => response(413, { message: "Request too large" }) });
  await assert.rejects(
    () => createSession(ctx).request({ method: "POST", path: v2("/pages"), scope: SCOPES.create }),
    (error: unknown) => {
      assert.ok(error instanceof ConfluenceRequestError);
      assert.equal(error.kind, "too-large");
      assert.match(error.cliMessage, /413/);
      assert.match(error.cliMessage, /5 MB/);
      // The scope name is what a permission failure looks like here, so a size
      // failure must not carry it.
      assert.doesNotMatch(error.cliMessage, /write:page:confluence/);
      return true;
    },
  );
});

test("any other non-2xx carries status, method and path", async () => {
  const { ctx } = harness({ api: () => response(404, { message: "No page with id 1" }) });
  await assert.rejects(
    () => createSession(ctx).request(GET_PAGE),
    (error: unknown) => {
      assert.ok(error instanceof ConfluenceRequestError);
      assert.equal(error.kind, "http");
      assert.equal(error.status, 404);
      assert.match(error.cliMessage, /HTTP 404 on GET \/wiki\/api\/v2\/pages\/1 - No page with id 1/);
      return true;
    },
  );
});

test("neither the secret nor the bearer token appears in any failure", async () => {
  for (const status of [400, 401, 403, 413, 500]) {
    const { ctx } = harness({ api: () => response(status, { message: "nope" }) });
    await assert.rejects(
      () => createSession(ctx).request(GET_PAGE),
      (error: unknown) => {
        const seen = `${(error as Error).message}${(error as Error).stack ?? ""}${JSON.stringify(error)}`;
        assert.doesNotMatch(seen, new RegExp(CLIENT_SECRET));
        assert.doesNotMatch(seen, new RegExp(ACCESS_TOKEN));
        return true;
      },
    );
  }
});

test("a failed token request reports the status, never the secret", async () => {
  const { ctx } = harness({ token: () => response(401, { error: "invalid_client" }) });
  await assert.rejects(
    () => createSession(ctx).request(GET_PAGE),
    (error: unknown) => {
      assert.ok(error instanceof ConfluenceError);
      assert.match(error.cliMessage, /HTTP 401 invalid_client/);
      assert.doesNotMatch(error.cliMessage, new RegExp(CLIENT_SECRET));
      return true;
    },
  );
});

test("token and cloudId are resolved once per run and never shared between runs", async () => {
  const first = harness();
  const session = createSession(first.ctx);
  await session.request(GET_PAGE);
  await session.request(GET_PAGE);
  assert.equal(first.of("auth.atlassian.com").length, 1, "the token was requested more than once in one run");
  assert.equal(first.of("tenant_info").length, 1, "the cloudId was resolved more than once in one run");

  // A second context in the SAME process authenticates again. If the cache were
  // module-global this second run would silently write under the first run's
  // identity, which is the whole reason it hangs on the context.
  const second = harness();
  await createSession(second.ctx).request(GET_PAGE);
  assert.equal(second.of("auth.atlassian.com").length, 1);
  assert.equal(first.ctx.session.token, ACCESS_TOKEN);
  assert.equal(second.ctx.session.token, ACCESS_TOKEN);
  assert.notEqual(first.ctx.session, second.ctx.session);
});

test("the credential variable is a parameter, so the foreign one alone is not read", async () => {
  const { ctx, calls } = harness({
    env: { KHEREP_ATL_SITE: SITE, [CODEX_ENV]: CRED_PATH },
    credEnv: CLAUDE_ENV,
  });
  await assert.rejects(
    () => createSession(ctx).request(GET_PAGE),
    (error: unknown) => {
      assert.ok(error instanceof ConfluenceError);
      assert.equal(error.cliMessage, `${CLAUDE_ENV} is not set.`);
      return true;
    },
  );
  assert.deepEqual(calls, [], "a missing credential variable must fail before any request");
});

test("tenant_info is called without a header and the API call carries the bearer", async () => {
  const { ctx, of } = harness();
  await createSession(ctx).request({ ...GET_PAGE, method: "PUT", body: { id: "1" } });
  assert.equal(of("tenant_info")[0].options, undefined);
  const api = of("/ex/confluence/")[0];
  assert.equal(api.url, `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/1`);
  assert.equal(api.options?.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(api.options?.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(api.options?.body)), { id: "1" });
});

test("a site that is not a credential-free HTTPS origin is refused", async () => {
  for (const site of ["http://wiki.example.com", "https://user:pw@wiki.example.com", "https://wiki.example.com/wiki", "nonsense"]) {
    const { ctx } = harness({ env: { KHEREP_ATL_SITE: site, [CLAUDE_ENV]: CRED_PATH } });
    await assert.rejects(() => createSession(ctx).request(GET_PAGE), ConfluenceError);
  }
});

test("selftest discriminates a tampered secret and reports only the token length", async () => {
  const { ctx } = harness({
    token: (body) => (body.client_secret === CLIENT_SECRET
      ? response(200, { access_token: ACCESS_TOKEN, expires_in: 3600 })
      : response(401, { error: "invalid_client" })),
  });
  const report = await authenticationReport(ctx);
  assert.equal(report.ok, true);
  const printed = report.lines.join("\n");
  assert.match(printed, new RegExp(`length ${ACCESS_TOKEN.length}`));
  assert.doesNotMatch(printed, new RegExp(ACCESS_TOKEN));
  assert.doesNotMatch(printed, new RegExp(CLIENT_SECRET));
  assert.doesNotMatch(printed, new RegExp(CLIENT_ID));
});

// OP-1415. Not discriminating is only inconclusive while BOTH answers are the
// same, which is what a rotated or revoked secret looks like.
test("selftest separates a check that cannot tell from one that refuses the genuine secret", async () => {
  const { ctx } = harness({ token: () => response(200, { access_token: ACCESS_TOKEN, expires_in: 3600 }) });
  const report = await authenticationReport(ctx);
  assert.equal(report.ok, false);
  assert.match(report.lines.join("\n"), /verdict: UNKNOWN/);
  // Different answers mean the endpoint CAN tell the two apart, and the one it
  // refused was the genuine secret: conclusive, not unknown.
  const refused = harness({ token: ({ client_secret: sent }) => response(401,
    { error: sent === CLIENT_SECRET ? "invalid_client" : "access_denied" }) });
  const second = await authenticationReport(refused.ctx);
  assert.equal(second.ok, false);
  assert.match(second.lines.join("\n"), /verdict: FAIL/);
});

test("the identity probe is optional and a 403 on it is not a selftest failure", async () => {
  const forbidden = harness({ api: () => response(403, { message: "no user scope" }) });
  assert.equal(await currentUser(createSession(forbidden.ctx)), null);
  const known = harness({ api: () => response(200, { accountId: "account-for-tests", displayName: "Service Account" }) });
  assert.deepEqual(await currentUser(createSession(known.ctx)), {
    accountId: "account-for-tests",
    displayName: "Service Account",
  });
});
