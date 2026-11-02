// CLI tests for the Claude Confluence broker. Injected fetch and readFile,
// synthetic values only: nothing here reads a credential file or reaches a
// network. The Codex broker's test file is the same suite against the other
// credential variable - a property that holds on one broker by accident is not
// a property.
import assert from "node:assert/strict";
import test from "node:test";

import { runCli, type Injected } from "./atl-confluence-ccoder.mts";
import type { HttpResponse, RequestOptions } from "./confluence-session.mts";

const BROKER = "atl-confluence-ccoder.mts";
const OWN_ENV = "KHEREP_ATL_CRED_FILE_CLAUDE";
const FOREIGN_ENV = "KHEREP_ATL_CRED_FILE_CODEX";

const CLIENT_ID = "client-id-for-tests";
const CLIENT_SECRET = "secret-for-tests-1234";
const ACCESS_TOKEN = "access-token-must-never-be-reported";
const CLOUD_ID = "cloud-id-for-tests";
const CRED_PATH = "/nowhere/credentials-for-tests";
const CRED_TEXT = `Client ID: ${CLIENT_ID}\nSecret: ${CLIENT_SECRET}\n`;
const SITE = "https://wiki.example.com";
const AUTHOR = "service-account-for-tests";
// Compared whole: a regex with an unescaped "|" matched this line on any one of
// its words and so asserted nothing.
const VERBS = ["create", "update", "get", "delete", "purge", "labels", "move", "space", "children", "related",
  "search", "list", "context", "orphans", "stitch", "drainage", "evidence", "selftest"];
const USAGE = `Usage: ${VERBS.join(" | ")}. Run help for the flags of each verb.`;

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

const SPACE = { results: [{ id: "9001", key: "KB", name: "Knowledge" }] };
const PAGE = {
  id: "5001",
  title: "New page",
  status: "current",
  spaceId: "9001",
  authorId: AUTHOR,
  version: { number: 1 },
  _links: { webui: "/spaces/KB/pages/5001" },
};

function harness(options: { env?: Record<string, string | undefined>; api?: (call: Call) => HttpResponse } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  // What reached stdout through the payload channel, chunk by chunk.
  const written: string[] = [];
  const injected: Injected = {
    env: options.env ?? { KHEREP_ATL_SITE: SITE, [OWN_ENV]: CRED_PATH },
    async readFile(path) {
      if (path !== CRED_PATH) throw new Error("no such file");
      return CRED_TEXT;
    },
    async fetch(url, requestOptions) {
      calls.push({ url, options: requestOptions });
      if (url.startsWith("https://auth.atlassian.com")) {
        return response(200, { access_token: ACCESS_TOKEN, expires_in: 3600 });
      }
      if (url.endsWith("/_edge/tenant_info")) return response(200, { cloudId: CLOUD_ID });
      return options.api ? options.api({ url, options: requestOptions }) : response(200, {});
    },
    log: (line) => { out.push(line); },
    logError: (line) => { err.push(line); },
    now: () => 1_000_000,
    writeOut: (chunk) => { written.push(chunk); },
  };
  return { out, err, calls, written, injected, printed: () => [...out, ...err].join("\n") };
}

function defaultApi(call: Call): HttpResponse {
  if (call.url.includes("/spaces?keys=")) return response(200, SPACE);
  if (call.url.endsWith("/wiki/api/v2/pages")) return response(200, PAGE);
  if (call.url.includes("/wiki/api/v2/pages/5001")) return response(200, PAGE);
  return response(200, {});
}

test(`${BROKER} reads only ${OWN_ENV}`, async () => {
  const { err, calls, injected } = harness({ env: { KHEREP_ATL_SITE: SITE, [FOREIGN_ENV]: CRED_PATH } });
  assert.equal(await runCli(["get", "--id", "5001"], injected), 1);
  assert.deepEqual(err, [`${OWN_ENV} is not set.`]);
  assert.deepEqual(calls, [], "a missing credential variable must fail before any request");
});

test(`${BROKER} names its own variable even when the foreign one points at a readable file`, async () => {
  const { err, injected } = harness({
    env: { KHEREP_ATL_SITE: SITE, [FOREIGN_ENV]: CRED_PATH, [OWN_ENV]: undefined },
  });
  assert.equal(await runCli(["selftest"], injected), 1);
  assert.match(err.join("\n"), new RegExp(`${OWN_ENV} is not set`));
  assert.doesNotMatch(err.join("\n"), new RegExp(FOREIGN_ENV));
});

test(`${BROKER} refuses an unsupported --format before sending anything`, async () => {
  for (const format of ["markdown", "html", undefined]) {
    const { err, calls, injected } = harness({ api: defaultApi });
    const argv = ["create", "--space", "KB", "--title", "T", "--body", "x"];
    if (format !== undefined) argv.push("--format", format);
    assert.equal(await runCli(argv, injected), 1);
    assert.deepEqual(calls, [], `--format ${format} still sent a request`);
    assert.match(err.join("\n"), /--format/);
  }
});

test(`${BROKER} creates a page and proves the author by reading it back`, async () => {
  const { out, calls, injected } = harness({ api: defaultApi });
  const code = await runCli(
    ["create", "--space", "KB", "--title", "New page", "--body", "<p>x</p>", "--format", "storage"],
    injected,
  );
  assert.equal(code, 0);
  assert.match(out.join("\n"), new RegExp(`^authorId: ${AUTHOR}$`, "m"));
  assert.match(out.join("\n"), new RegExp(`^readback authorId: ${AUTHOR}$`, "m"));
  const created = calls.find((call) => call.options?.method === "POST" && call.url.endsWith("/wiki/api/v2/pages"));
  assert.ok(created, "no create request was sent");
  assert.deepEqual(JSON.parse(String(created.options?.body)), {
    spaceId: "9001",
    status: "current",
    title: "New page",
    body: { representation: "storage", value: "<p>x</p>" },
  });
  // The readback is a second, separate GET on the created page.
  assert.ok(calls.some((call) => call.options?.method === "GET" && call.url.includes("/wiki/api/v2/pages/5001")));
});

test(`${BROKER} reports UNVERIFIED authorship rather than a silent success`, async () => {
  const { out, err, injected } = harness({
    api: (call) => {
      if (call.url.includes("/spaces?keys=")) return response(200, SPACE);
      if (call.url.endsWith("/wiki/api/v2/pages")) return response(200, { ...PAGE, authorId: undefined });
      return response(200, { ...PAGE, authorId: undefined });
    },
  });
  const code = await runCli(
    ["create", "--space", "KB", "--title", "T", "--body", "x", "--format", "storage"],
    injected,
  );
  assert.equal(code, 1);
  assert.match(out.join("\n"), /readback authorId: UNKNOWN/);
  assert.match(err.join("\n"), /UNVERIFIED/);
});

test(`${BROKER} surfaces a 403 with the scope the verb needs`, async () => {
  const { err, injected } = harness({ api: () => response(403, { message: "Current user not permitted" }) });
  assert.equal(await runCli(["get", "--id", "5001"], injected), 1);
  assert.match(err.join("\n"), /read:page:confluence/);
});

test(`${BROKER} surfaces a 413 on create as a size failure`, async () => {
  const { err, injected } = harness({
    api: (call) => (call.url.includes("/spaces?keys=") ? response(200, SPACE) : response(413, { message: "too large" })),
  });
  assert.equal(await runCli(
    ["create", "--space", "KB", "--title", "T", "--body", "x", "--format", "storage"],
    injected,
  ), 1);
  assert.match(err.join("\n"), /5 MB/);
  assert.doesNotMatch(err.join("\n"), /write:page:confluence/);
});

test(`${BROKER} refuses to purge a page that is not trashed`, async () => {
  const { err, calls, injected } = harness({ api: () => response(200, PAGE) });
  assert.equal(await runCli(["purge", "--id", "5001"], injected), 1);
  assert.match(err.join("\n"), /not "trashed"/);
  assert.equal(calls.filter((call) => call.options?.method === "DELETE").length, 0);
});

test(`${BROKER} prints a usage line for an unknown verb`, async () => {
  const { err, calls, injected } = harness();
  assert.equal(await runCli(["publish"], injected), 1);
  assert.equal(err.join("\n"), USAGE);
  assert.deepEqual(calls, []);
});

// #299. A positional or an unknown flag used to be skipped silently, so
// `get 275907063` lost the id and failed without saying why.
test(`${BROKER} help lists every verb with its flags and exits 0 in all three spellings`, async () => {
  for (const spelling of ["help", "--help", "-h"]) {
    const { out, err, calls, injected } = harness();
    assert.equal(await runCli([spelling], injected), 0, spelling);
    assert.deepEqual(err, []);
    assert.deepEqual(calls, []);
    for (const verb of VERBS) assert.ok(out.some((line) => line.startsWith(`  ${verb}`)), `${spelling} lacks ${verb}`);
    assert.ok(out.includes("  get --id <id> [--format <storage|adf>] [--body-only]"), out.join("\n"));
    assert.ok(out.includes("  stitch --space <key> [--id <id>] [--topic <text>] [--out <receipt>] [--candidates <receipt>]"
      + " [--decisions <file>] [--limit <n>] [--per-orphan <n>]"), out.join("\n"));
    assert.ok(out.some((line) => line.startsWith("  evidence --mode <prepare|decide|verify|report|record> [")), out.join("\n"));
  }
});

test(`${BROKER} refuses a positional and names the call it probably meant`, async () => {
  const { err, calls, injected } = harness({ api: defaultApi });
  assert.equal(await runCli(["get", "275907063"], injected), 1);
  assert.deepEqual(err, [[
    "get expects --id <id>; got positional '275907063'.",
    "Did you mean: get --id 275907063",
    "Usage: get --id <id> [--format <storage|adf>] [--body-only]",
  ].join("\n")]);
  assert.deepEqual(calls, [], "a refused call must not reach the network");
});

test(`${BROKER} refuses an unknown flag and names the verb syntax`, async () => {
  const { err, calls, injected } = harness({ api: defaultApi });
  assert.equal(await runCli(["get", "--id", "5001", "--title", "x"], injected), 1);
  assert.deepEqual(err, ["get does not take --title.\nUsage: get --id <id> [--format <storage|adf>] [--body-only]"]);
  assert.deepEqual(calls, []);
});

test(`${BROKER} prints the full syntax for a missing required flag`, async () => {
  const { err, calls, injected } = harness({ api: defaultApi });
  assert.equal(await runCli(["move", "--id", "5001"], injected), 1);
  assert.deepEqual(err, ["move: --parent is missing.\nUsage: move --id <id> --parent <id>"]);
  assert.deepEqual(calls, []);
});

test(`${BROKER} refuses a flag given twice instead of keeping the last value`, async () => {
  const { err, calls, injected } = harness({ api: defaultApi });
  assert.equal(await runCli(["get", "--id", "5001", "--id", "5002"], injected), 1);
  assert.match(err.join("\n"), /--id was given more than once/);
  assert.deepEqual(calls, []);
});

test(`${BROKER} selftest takes no arguments`, async () => {
  const { err, calls, injected } = harness({ api: defaultApi });
  assert.equal(await runCli(["selftest", "--id", "5001"], injected), 1);
  assert.deepEqual(err, ["selftest does not take --id.\nUsage: selftest"]);
  assert.deepEqual(calls, []);
});

// Issue #736. Three flag combinations and nothing in between: candidates
// (--id --topic --out), write (--id --candidates --decisions) and the read-only
// sweep (no --id). A mixed or partial call is refused before any request.
for (const argv of [
  ["--dry-run", "--id", "404"],
  ["--id", "404"],
  ["--id", "404", "--topic", "A topic sentence"],
  ["--id", "404", "--topic", "A topic sentence", "--out", "r.json", "--decisions", "d.txt"],
  ["--id", "404", "--candidates", "r.json"],
  ["--id", "404", "--candidates", "r.json", "--decisions", "d.txt", "--per-orphan", "2"],
  ["--id", "404", "--topic", "A topic sentence", "--out", "r.json", "--limit", "3"],
  ["--topic", "A topic sentence", "--out", "r.json"],
  ["--limit", "3", "--decisions", "d.txt"],
]) {
  test(`${BROKER} stitch ${argv.join(" ")} is refused before any request`, async () => {
    const { out, err, calls, injected } = harness({ api: defaultApi });
    injected.semantic = async () => { throw new Error("stitch must not search"); };
    assert.equal(await runCli(["stitch", "--space", "KB", ...argv], injected), 1);
    assert.deepEqual(out, []);
    assert.equal(err.length, 1);
    assert.match(err[0], argv[0] === "--dry-run" ? /^stitch does not take --dry-run\./ : /^stitch takes one of three forms: /);
    assert.deepEqual(calls, [], "not even the space lookup runs");
  });
}

test(`${BROKER} stitch refuses an empty --topic before any request`, async () => {
  const { err, calls, injected } = harness({ api: defaultApi });
  assert.equal(await runCli(["stitch", "--space", "KB", "--id", "404", "--topic", "  ", "--out", "r.json"], injected), 1);
  assert.deepEqual(err, ["--topic is empty. A title alone is not a topic; nothing was searched."]);
  assert.deepEqual(calls, []);
});

// Issue #710. On 2026-10-31 an observation run passed an empty --id; the falsy
// value fell through to the full-space sweep and wrote to 127 unrelated pages.
// A present --id that names no page fails before any request, sweep included.
for (const id of ["", "   ", "abc", "12a"]) {
  test(`${BROKER} stitch --id ${JSON.stringify(id)} fails before any request and writes nothing`, async () => {
    const { out, err, calls, injected } = harness({ api: defaultApi });
    injected.semantic = async () => { throw new Error("stitch must not search"); };
    assert.equal(await runCli(["stitch", "--space", "KB", "--id", id, "--per-orphan", "2"], injected), 1);
    assert.deepEqual(err, ["--id must be a numeric Confluence page id. Nothing was searched or written; the full-space sweep runs only without --id."]);
    assert.deepEqual(out, []);
    assert.deepEqual(calls, [], "not even the space lookup runs");
  });
}

test(`${BROKER} search with a malformed call is unavailable, not a measured no match`, async () => {
  const { out, err, calls, injected } = harness({ api: defaultApi });
  assert.equal(await runCli(["search", "--space", "KB", "hook order"], injected), 2);
  assert.deepEqual(out, ["status: unavailable"]);
  assert.match(err.join("\n"), /got positional 'hook order'/);
  assert.match(err.join("\n"), /Did you mean: search --query "hook order"/);
  assert.deepEqual(calls, []);
});

test(`${BROKER} never prints the secret or the bearer token`, async () => {
  const runs: string[][] = [
    ["create", "--space", "KB", "--title", "T", "--body", "x", "--format", "storage"],
    ["get", "--id", "5001"],
    ["update", "--id", "5001", "--body", "x", "--format", "wiki"],
    ["delete", "--id", "5001"],
    ["labels", "--id", "5001", "--labels", "alpha"],
    ["labels", "--id", "5001", "--keep-runtime", "runtime-claude-code-win"],
    ["move", "--id", "5001", "--parent", "7001"],
    ["space", "--space", "KB"],
    ["children", "--id", "5001"],
    ["selftest"],
    ["get", "--id", "nope"],
  ];
  for (const argv of runs) {
    const { printed, injected } = harness({ api: defaultApi });
    await runCli(argv, injected);
    const text = printed();
    assert.doesNotMatch(text, new RegExp(CLIENT_SECRET), `${argv[0]} printed the secret`);
    assert.doesNotMatch(text, new RegExp(ACCESS_TOKEN), `${argv[0]} printed the token`);
    assert.doesNotMatch(text, new RegExp(CRED_PATH), `${argv[0]} printed the credential path`);
  }
});

test(`${BROKER} selftest resolves the cloudId and reports the token length only`, async () => {
  const { out, injected } = harness({
    api: (call) => (call.url.endsWith("/wiki/rest/api/user/current")
      ? response(200, { accountId: AUTHOR, displayName: "Service Account" })
      : response(200, {})),
  });
  // Two identical token answers cannot discriminate a tampered secret, so the
  // verdict is UNKNOWN and the exit code says so.
  assert.equal(await runCli(["selftest"], injected), 1);
  const text = out.join("\n");
  assert.match(text, new RegExp(`length ${ACCESS_TOKEN.length}`));
  assert.match(text, new RegExp(`cloudId: ${CLOUD_ID}`));
  assert.match(text, new RegExp(`account: ${AUTHOR} \\(Service Account\\)`));
  assert.doesNotMatch(text, new RegExp(ACCESS_TOKEN));
});

test(`${BROKER} update sends the version it read`, async () => {
  const { calls, injected } = harness({
    api: (call) => (call.options?.method === "GET"
      ? response(200, { ...PAGE, version: { number: 4 } })
      : response(200, { ...PAGE, version: { number: 5 } })),
  });
  assert.equal(await runCli(["update", "--id", "5001", "--body", "x", "--format", "storage"], injected), 0);
  const put = calls.find((call) => call.options?.method === "PUT");
  assert.ok(put);
  const body = JSON.parse(String(put.options?.body)) as { version: { number: number } };
  assert.equal(body.version.number, 5);
});

// #299. A caller's --version used to be read past and ignored; it is now refused
// outright, before anything is read or sent.
test(`${BROKER} update refuses a caller-supplied --version`, async () => {
  const { err, calls, injected } = harness({ api: defaultApi });
  assert.equal(await runCli(
    ["update", "--id", "5001", "--body", "x", "--format", "storage", "--version", "99"],
    injected,
  ), 1);
  assert.match(err.join("\n"), /^update does not take --version\./);
  assert.deepEqual(calls, []);
});

// OP-1419. The re-parenting verb. `movePage` had existed and been covered since
// OP-1409 with no caller able to reach it, so these two cases are the first
// that go through a command line at all.
function moveApi(target: string, atTarget: unknown[]) {
  return (call: Call): HttpResponse => {
    if (call.url.includes("/wiki/api/v2/pages/5001?body-format=storage")) {
      return response(200, { ...PAGE, parentId: "4000", body: { storage: { value: "<p>unchanged</p>" } } });
    }
    if (call.url.includes(`/wiki/api/v2/pages/${target}/children`)) return response(200, { results: atTarget });
    if (call.options?.method === "PUT") return response(200, { ...PAGE, version: { number: 2 } });
    return response(200, {});
  };
}

test(`${BROKER} moves a page and proves it from the target's own child list`, async () => {
  const { out, calls, injected } = harness({ api: moveApi("7001", [{ id: "5001", title: "New page" }]) });
  assert.equal(await runCli(["move", "--id", "5001", "--parent", "7001"], injected), 0);
  const put = calls.find((call) => call.options?.method === "PUT");
  assert.ok(put, "no move was sent");
  const body = JSON.parse(String(put.options?.body)) as { parentId: string; body: { value: string } };
  assert.equal(body.parentId, "7001");
  assert.equal(body.body.value, "<p>unchanged</p>", "the body that was read goes back unchanged");
  assert.match(out.join("\n"), /^from parent: 4000$/m);
  assert.match(out.join("\n"), /^readback parent: 7001$/m);
  // The evidence is a SEPARATE read of the target, not the answer to the write.
  assert.ok(calls.some((call) => call.options?.method === "GET" && call.url.includes("/pages/7001/children")));
});

test(`${BROKER} reports a move it cannot see at the target as UNVERIFIED`, async () => {
  const { err, out, injected } = harness({ api: moveApi("7001", [{ id: "6002", title: "Elsewhere" }]) });
  assert.equal(await runCli(["move", "--id", "5001", "--parent", "7001"], injected), 1);
  assert.match(err.join("\n"), /UNVERIFIED/);
  assert.doesNotMatch(out.join("\n"), /readback parent/);
});

// get --body-only prints the page body and nothing else to stdout, so
// `get --id <page> --body-only > page.xml` is exactly the body. The broker
// itself writes no file.
const BODY_TEXT = "<p>body</p>\n<p>second line, no newline after it</p>";
const ADF_TEXT = JSON.stringify({ type: "doc", version: 1, content: [{ type: "paragraph" }] });

function bodyApi(body: unknown) {
  return (call: Call): HttpResponse => (call.url.includes("/wiki/api/v2/pages/5001")
    ? response(200, { ...PAGE, body })
    : response(200, {}));
}

function pageReads(calls: Call[]): string[] {
  return calls.filter((call) => call.url.includes("/wiki/api/v2/pages/"))
    .map((call) => call.url.replace(/^.*\/wiki/, "/wiki"));
}

test(`${BROKER} get --body-only prints only the storage body, with one request`, async () => {
  const { out, err, written, calls, injected } = harness({ api: bodyApi({ storage: { value: BODY_TEXT } }) });
  assert.equal(await runCli(["get", "--id", "5001", "--body-only"], injected), 0);
  assert.equal(written.join(""), BODY_TEXT, "stdout is the body, byte for byte, without an added newline");
  assert.deepEqual(out, [], "no metadata line may reach stdout");
  assert.deepEqual(err, []);
  assert.deepEqual(pageReads(calls), ["/wiki/api/v2/pages/5001?body-format=storage"]);
});

test(`${BROKER} get --body-only takes the flag in any position`, async () => {
  const { out, written, calls, injected } = harness({ api: bodyApi({ storage: { value: BODY_TEXT } }) });
  assert.equal(await runCli(["get", "--body-only", "--id", "5001", "--format", "storage"], injected), 0);
  assert.equal(written.join(""), BODY_TEXT);
  assert.deepEqual(out, []);
  assert.deepEqual(pageReads(calls), ["/wiki/api/v2/pages/5001?body-format=storage"]);
});

test(`${BROKER} get --body-only --format adf asks for atlas_doc_format`, async () => {
  const { out, written, calls, injected } = harness({ api: bodyApi({ atlas_doc_format: { value: ADF_TEXT } }) });
  assert.equal(await runCli(["get", "--id", "5001", "--body-only", "--format", "adf"], injected), 0);
  assert.equal(written.join(""), ADF_TEXT);
  assert.deepEqual(out, []);
  assert.deepEqual(pageReads(calls), ["/wiki/api/v2/pages/5001?body-format=atlas_doc_format"]);
});

test(`${BROKER} get --body-only refuses any --format but storage and adf before sending anything`, async () => {
  const cases: string[][] = [
    ["--format", "wiki"], ["--format", "markdown"], ["--format", "atlas_doc_format"], ["--format", ""], ["--format"],
  ];
  for (const extra of cases) {
    const { err, out, written, calls, injected } = harness({ api: bodyApi({ storage: { value: BODY_TEXT } }) });
    assert.equal(await runCli(["get", "--id", "5001", "--body-only", ...extra], injected), 1);
    assert.match(err.join("\n"), /--format/);
    assert.deepEqual(calls, [], `${extra.join(" ")} still sent a request`);
    assert.deepEqual(written, []);
    assert.deepEqual(out, []);
  }
});

test(`${BROKER} get refuses --format without --body-only before sending anything`, async () => {
  const { err, out, calls, injected } = harness({ api: bodyApi({ storage: { value: BODY_TEXT } }) });
  assert.equal(await runCli(["get", "--id", "5001", "--format", "adf"], injected), 1);
  assert.match(err.join("\n"), /--body-only/, "--format alone must not be silently ignored");
  assert.deepEqual(calls, []);
  assert.deepEqual(out, []);
});

test(`${BROKER} get --body-only fails when the answer lacks the requested representation`, async () => {
  const { err, out, written, injected } = harness({ api: bodyApi({ atlas_doc_format: { value: ADF_TEXT } }) });
  assert.equal(await runCli(["get", "--id", "5001", "--body-only"], injected), 1);
  assert.match(err.join("\n"), /without a storage body/);
  assert.deepEqual(written, [], "an empty stdout must not stand in for the body");
  assert.deepEqual(out, []);
});

test(`${BROKER} get --body-only prints nothing for a page that cannot be read`, async () => {
  const { err, out, written, injected } = harness({ api: () => response(404, { errors: [{ title: "Not Found" }] }) });
  assert.equal(await runCli(["get", "--id", "5001", "--body-only"], injected), 1);
  assert.match(err.join("\n"), /404/);
  assert.deepEqual(written, []);
  assert.deepEqual(out, []);
});

test(`${BROKER} get --body-only checks --id before sending anything`, async () => {
  const { err, written, calls, injected } = harness({ api: bodyApi({ storage: { value: BODY_TEXT } }) });
  assert.equal(await runCli(["get", "--body-only"], injected), 1);
  assert.match(err.join("\n"), /--id/);
  assert.deepEqual(calls, []);
  assert.deepEqual(written, []);
});

test(`${BROKER} plain get still prints the metadata lines and asks for no body`, async () => {
  const { out, err, written, calls, injected } = harness({ api: bodyApi({ storage: { value: BODY_TEXT } }) });
  assert.equal(await runCli(["get", "--id", "5001"], injected), 0);
  assert.deepEqual(out, [
    "id: 5001", "title: New page", "status: current", "version: 1",
    `authorId: ${AUTHOR}`, "link: /spaces/KB/pages/5001",
  ]);
  assert.deepEqual(err, []);
  assert.deepEqual(written, []);
  assert.deepEqual(pageReads(calls), ["/wiki/api/v2/pages/5001"]);
});


test(`${BROKER} validates expected-version before network and refuses stale reviewed bodies`, async () => {
  for (const version of ['0','-1','1.5','NaN','1e2',' 1','9007199254740992']) {
    const h = harness();
    assert.equal(await runCli(['update','--id','5001','--format','storage','--body','x','--expected-version',version],h.injected),1);
    assert.match(h.printed(),/expected-version/);
    assert.equal(h.calls.length,0);
  }
  const h = harness({api:defaultApi});
  assert.equal(await runCli(['update','--id','5001','--format','storage','--body','x','--expected-version','2'],h.injected),1);
  assert.match(h.printed(),/version mismatch/);
  assert.ok(!h.calls.some(c=>c.options?.method === 'PUT'));
});
test(`${BROKER} guarded update verifies target bytes through its shared implementation`, async () => {
  let wrote=false;
  const h = harness({api: call => {
    if (call.options?.method === 'PUT') wrote=true;
    return response(200,{...PAGE,version:{number:wrote?2:1},body:{storage:{value:'reviewed'}}});
  }});
  assert.equal(await runCli(['update','--id','5001','--format','storage','--body','reviewed','--expected-version','1'],h.injected),0);
  assert.ok(wrote);
  assert.match(h.printed(),/version sent: 2/);
});
test(`${BROKER} drainage requires classified metadata and prints a bounded JSON report`, async () => {
  const refused = harness();
  assert.equal(await runCli(['drainage','--space','KB'],refused.injected),1);
  assert.equal(refused.calls.length,0);
  const h = harness({api: call => {
    if (call.url.includes('/spaces?keys=')) return response(200,SPACE);
    if (call.url.includes('/spaces/9001/pages')) return response(200,{results:[{...PAGE,parentId:null}]});
    if (call.url.includes('/labels')) return response(200,{results:[]});
    return response(200,{...PAGE,parentId:null,body:{storage:{value:'Never emit this private fixture body'}}});
  }});
  assert.equal(await runCli(['drainage','--space','KB','--metadata-approved'],h.injected),0);
  const report = JSON.parse(h.out.join(''));
  assert.equal(report.inventory.status,'complete');
  assert.equal(report.semanticReview,'UNKNOWN');
  assert.ok(!h.printed().includes('Never emit'));
  assert.ok(!h.calls.some(c=>(c.options?.method ?? 'GET') !== 'GET' && new URL(c.url).origin !== 'https://auth.atlassian.com'));
});

test(`${BROKER} a successful PUT followed by readback failure is safely UNVERIFIED`, async () => {
  for (const malformed of [false,true]) {
    let wrote=false;
    const h = harness({api:call => {
      if (call.options?.method === 'PUT') { wrote=true; return response(200,{...PAGE,version:{number:2}}); }
      if (wrote) return malformed ? response(200,{}) : response(500,{message:'SENSITIVE synthetic server detail'});
      return response(200,PAGE);
    }});
    assert.equal(await runCli(['update','--id','5001','--format','storage','--body','reviewed','--expected-version','1'],h.injected),1);
    assert.equal(h.calls.filter(c=>c.options?.method === 'PUT').length,1);
    assert.match(h.printed(),/UNVERIFIED/);
    assert.ok(!h.printed().includes('SENSITIVE'));
  }
});
