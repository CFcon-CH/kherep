// The labels verb and the runtime-label rule, driven through both brokers'
// command lines: OP-1436 --remove, and issue #318 (labels --id is read-only,
// one runtime label per page, create always labels, --keep-runtime). One suite
// for both brokers, like confluence-list.test.mts: they share
// confluence-label-cli.mts, and a property that holds on one broker by
// accident is not a property. Injected fetch and readFile, synthetic values
// only: no credential file, no network.
import assert from "node:assert/strict";
import test from "node:test";

import { runCli as runClaude, type Injected } from "./atl-confluence-ccoder.mts";
import { runCli as runCodex } from "./atl-confluence.mts";
import { runtimeLabel } from "./confluence-runtime-label.mts";
import type { HttpResponse, RequestOptions } from "./confluence-session.mts";

const BROKERS = [
  { name: "atl-confluence-ccoder.mts", run: runClaude, env: "KHEREP_ATL_CRED_FILE_CLAUDE" },
  { name: "atl-confluence.mts", run: runCodex, env: "KHEREP_ATL_CRED_FILE_CODEX" },
];

const SITE = "https://wiki.example.com";
// #760 contract A: the Claude broker's create files observations only, from a validated body file.
const OBS_FILE = "C:/assigned/observation.xml";
const OBS_LABELS = ["type-observation", "evidence-assumed", "status-author-model"];
const OBS_BODY = "<p>Finding: x</p><p>Origin: synthetic turn.</p><p>Source: fixture.</p><p>Timestamp: now.</p>";
const CRED_PATH = "/nowhere/credentials-for-tests";
const CRED_TEXT = "Client ID: client-id-for-tests\nSecret: secret-for-tests-1234\n";

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
  authorId: "service-account-for-tests",
  version: { number: 1 },
  _links: { webui: "/spaces/KB/pages/5001" },
};

function defaultApi(call: Call): HttpResponse {
  if (call.url.includes("/spaces?keys=")) return response(200, SPACE);
  if (call.url.endsWith("/wiki/api/v2/pages")) return response(200, PAGE);
  if (call.url.includes("/wiki/api/v2/pages/5001")) return response(200, PAGE);
  return response(200, {});
}

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  api?: (call: Call) => HttpResponse;
}

function brokerHarness(ownEnv: string, options: HarnessOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const injected: Injected = {
    env: options.env ?? { KHEREP_ATL_SITE: SITE, [ownEnv]: CRED_PATH },
    async readFile(path) {
      if (path !== CRED_PATH) throw new Error("no such file");
      return CRED_TEXT;
    },
    async readBodyBytes(file) { assert.equal(file, OBS_FILE); return Buffer.from(OBS_BODY); },
    async fetch(url, requestOptions) {
      calls.push({ url, options: requestOptions });
      if (new URL(url).origin === "https://auth.atlassian.com") return response(200, { access_token: "token", expires_in: 3600 });
      if (url.endsWith("/_edge/tenant_info")) return response(200, { cloudId: "cloud-id-for-tests" });
      return options.api ? options.api({ url, options: requestOptions }) : response(200, {});
    },
    log: (line) => { out.push(line); },
    logError: (line) => { err.push(line); },
    now: () => 1_000_000,
  };
  return { out, err, calls, injected };
}

// OP-1436. The labels verb could only add, so a wrong evidence or session label
// could not be corrected without leaving two contradicting labels on the page.
function labelApi(after: string[]) {
  return (call: Call): HttpResponse => {
    if (call.options?.method === "DELETE") return response(204, null);
    if (call.url.includes("/pages/5001/labels")) return response(200, { results: after.map((name) => ({ name })) });
    return response(200, { results: [] });
  };
}

// Issue #318. `labels --id` alone used to post the runtime label, so reading a
// page's labels wrote one, and a page touched from two hosts ended up with two
// runtime labels. Each test page here keeps its labels in a set that the
// broker's own writes change, so a read-back sees what the site would show.
function labelPage(initial: string[], options: { stuck?: string } = {}) {
  const labels = new Set(initial);
  const listed = () => response(200, { results: [...labels].map((name) => ({ name })) });
  return (call: Call): HttpResponse => {
    const method = call.options?.method;
    const removed = /\/label\?name=([^&]+)$/.exec(call.url)?.[1];
    if (method === "DELETE" && removed) {
      const name = decodeURIComponent(removed);
      if (name !== options.stuck) labels.delete(name);
      return response(204, null);
    }
    if (method === "POST" && call.url.endsWith("/label")) {
      for (const row of JSON.parse(String(call.options?.body)) as { name: string }[]) labels.add(row.name);
      return listed();
    }
    if (call.url.includes("/pages/5001/labels")) return listed();
    return defaultApi(call);
  };
}

function labelWrites(calls: Call[]): Call[] {
  return calls.filter((call) => (call.options?.method === "POST" || call.options?.method === "DELETE")
    && call.url.includes("/label"));
}

function postedNames(calls: Call[]): string[] {
  const posts = labelWrites(calls).filter((call) => call.options?.method === "POST");
  assert.equal(posts.length, 1, "exactly one label write was expected");
  return (JSON.parse(String(posts[0].options?.body)) as { name: string }[]).map((row) => row.name);
}

for (const { name: BROKER, run: runCli, env: OWN_ENV } of BROKERS) {
  const harness = (options: HarnessOptions = {}) => brokerHarness(OWN_ENV, options);
  const gated = BROKER === "atl-confluence-ccoder.mts", base = gated ? OBS_LABELS : [];
  const createArgv = (labels: string[] = []) => ["create", "--space", "KB", "--title", "New page", "--format", "storage",
    ...(gated ? ["--body-file", OBS_FILE] : ["--body", "<p>x</p>"]), ...(base.length + labels.length ? ["--labels", [...base, ...labels].join(",")] : [])];
  const LABEL_ENV = { KHEREP_ATL_SITE: SITE, [OWN_ENV]: CRED_PATH, KHEREP_PROFILE: "win" };
  const HERE = runtimeLabel(OWN_ENV, { KHEREP_PROFILE: "win" });
  const THERE = runtimeLabel(OWN_ENV, { KHEREP_PROFILE: "mac" });

  test(`${BROKER} removes labels and proves it from a separate read of the page's labels`, async () => {
    const { out, calls, injected } = harness({ api: labelApi(["type-observation", "evidence-assumed"]) });
    assert.equal(await runCli(["labels", "--id", "5001", "--remove", "evidence-confirmed"], injected), 0);
    const deletes = calls.filter((call) => call.options?.method === "DELETE");
    assert.deepEqual(deletes.map((call) => call.url.replace(/^.*\/wiki/, "/wiki")),
      ["/wiki/rest/api/content/5001/label?name=evidence-confirmed"]);
    assert.ok(!calls.some((call) => call.options?.method === "POST" && call.url.includes("/label")),
      "a pure removal must not post the runtime label");
    assert.match(out.join("\n"), /^labels: type-observation, evidence-assumed$/m);
  });

  test(`${BROKER} removes first, then adds, when both are given`, async () => {
    const { calls, injected } = harness({ api: labelApi(["type-observation"]) });
    assert.equal(await runCli(["labels", "--id", "5001", "--remove", "evidence-confirmed", "--labels", "evidence-assumed"], injected), 0);
    const writes = calls.filter((call) => call.options?.method === "DELETE" || call.options?.method === "POST")
      .filter((call) => call.url.includes("/label"));
    assert.deepEqual(writes.map((call) => call.options?.method), ["DELETE", "POST"]);
  });

  test(`${BROKER} fails when a removed label is still on the page afterwards`, async () => {
    const { err, injected } = harness({ api: labelApi(["evidence-confirmed"]) });
    assert.equal(await runCli(["labels", "--id", "5001", "--remove", "evidence-confirmed"], injected), 1);
    assert.match(err.join("\n"), /still present: evidence-confirmed/);
  });

  test(`${BROKER} refuses to remove the runtime label before sending anything`, async () => {
    const { err, calls, injected } = harness({ api: labelApi([]) });
    assert.equal(await runCli(["labels", "--id", "5001", "--remove", "runtime-claude-code-win"], injected), 1);
    assert.ok(!calls.some((call) => call.url.includes("/label")), "no label request may be sent");
    assert.match(err.join("\n"), /runtime label/);
  });

  test(`${BROKER} labels --id alone reads the labels with one GET and writes nothing`, async () => {
    for (const [initial, line] of [[["type-observation", HERE], `labels: type-observation, ${HERE}`], [[], "labels: none"]] as const) {
      const { out, err, calls, injected } = harness({ env: LABEL_ENV, api: labelPage([...initial]) });
      assert.equal(await runCli(["labels", "--id", "5001"], injected), 0);
      assert.deepEqual(labelWrites(calls), [], "a read must not write a label");
      assert.equal(calls.filter((call) => call.url.includes("/pages/5001/labels")).length, 1);
      assert.deepEqual(out, [line]);
      assert.deepEqual(err, []);
    }
  });

  test(`${BROKER} labels --labels keeps an existing runtime label and does not add a second`, async () => {
    const { out, calls, injected } = harness({ env: LABEL_ENV, api: labelPage(["type-observation", THERE]) });
    assert.equal(await runCli(["labels", "--id", "5001", "--labels", `alpha,${HERE}`], injected), 0);
    assert.deepEqual(postedNames(calls), ["alpha"], "the caller's runtime label is stripped, the computed one withheld");
    const read = calls.findIndex((call) => call.url.includes("/pages/5001/labels"));
    const write = calls.indexOf(labelWrites(calls)[0]);
    assert.ok(read >= 0 && read < write, "the labels must be read before the write");
    assert.ok(out.includes(`runtime: kept ${THERE}`), out.join("\n"));
    assert.match(out.join("\n"), /^labels: .*\balpha\b/m);
  });

  test(`${BROKER} labels --labels adds the computed runtime label when the page has none`, async () => {
    const { out, calls, injected } = harness({ env: LABEL_ENV, api: labelPage(["type-observation"]) });
    assert.equal(await runCli(["labels", "--id", "5001", "--labels", "alpha,runtime-forged"], injected), 0);
    assert.deepEqual(postedNames(calls), ["alpha", HERE]);
    assert.ok(out.includes(`runtime: added ${HERE}`), out.join("\n"));
  });

  test(`${BROKER} labels --labels refuses when only a runtime label is left to add and one exists`, async () => {
    const { err, calls, injected } = harness({ env: LABEL_ENV, api: labelPage([THERE]) });
    assert.equal(await runCli(["labels", "--id", "5001", "--labels", HERE], injected), 1);
    assert.deepEqual(labelWrites(calls), []);
    assert.match(err.join("\n"), /nothing to add/);
  });

  test(`${BROKER} create ${gated ? "with only observation labels" : "without --labels"} still gets the computed runtime label`, async () => {
    const { out, calls, injected } = harness({ env: LABEL_ENV, api: labelPage([]) });
    assert.equal(await runCli(createArgv(), injected), 0);
    assert.deepEqual(postedNames(calls), [...base, HERE]);
    assert.ok(out.includes(`runtime: added ${HERE}`), out.join("\n"));
  });

  test(`${BROKER} create with --labels posts them together with the computed runtime label`, async () => {
    const { calls, injected } = harness({ env: LABEL_ENV, api: labelPage([]) });
    assert.equal(await runCli(createArgv(["alpha", "runtime-forged"]), injected), 0);
    assert.deepEqual(postedNames(calls), [...base, "alpha", HERE]);
  });

  test(`${BROKER} create says the page exists unlabelled when the runtime label write fails`, async () => {
    const page = labelPage([]);
    const api = (call: Call) => (call.options?.method === "POST" && call.url.endsWith("/label")
      ? response(500, { message: "label write failed" }) : page(call));
    const { out, err, injected } = harness({ env: LABEL_ENV, api });
    assert.equal(await runCli(createArgv(), injected), 1);
    assert.ok(out.includes("id: 5001"), out.join("\n"));
    assert.match(err.join("\n"), /Page 5001 exists, but its runtime label could not be written/);
  });

  test(`${BROKER} --keep-runtime removes the other runtime label and proves it by reading back`, async () => {
    const { out, err, calls, injected } = harness({ env: LABEL_ENV, api: labelPage(["type-observation", HERE, THERE]) });
    assert.equal(await runCli(["labels", "--id", "5001", "--keep-runtime", THERE], injected), 0);
    assert.deepEqual(labelWrites(calls).map((call) => `${call.options?.method} ${call.url.replace(/^.*\/wiki/, "/wiki")}`),
      [`DELETE /wiki/rest/api/content/5001/label?name=${HERE}`]);
    assert.deepEqual(out, [`runtime: kept ${THERE}`, `runtime: removed ${HERE}`, `labels: type-observation, ${THERE}`]);
    assert.deepEqual(err, []);
  });

  test(`${BROKER} --keep-runtime fails when the removed runtime label is still there afterwards`, async () => {
    const { out, err, injected } = harness({ env: LABEL_ENV, api: labelPage([HERE, THERE], { stuck: HERE }) });
    assert.equal(await runCli(["labels", "--id", "5001", "--keep-runtime", THERE], injected), 1);
    assert.match(err.join("\n"), new RegExp(`still present: ${HERE}`));
    assert.ok(!out.includes(`runtime: removed ${HERE}`), "a label that is still there was not removed");
  });

  test(`${BROKER} --keep-runtime refuses every case that is not the known two-label fault`, async () => {
    const cases: { name: string; initial: string[]; argv: string[]; error: RegExp; noRequest?: boolean }[] = [
      { name: "one runtime label", initial: ["type-observation", HERE], argv: ["--keep-runtime", HERE],
        error: /one runtime label: nothing to repair/ },
      { name: "no runtime label", initial: ["type-observation"], argv: ["--keep-runtime", HERE],
        error: /nothing to repair/ },
      { name: "keep label absent", initial: [HERE, THERE], argv: ["--keep-runtime", "runtime-other-win"],
        error: /runtime-other-win is not on the page/ },
      { name: "more than two", initial: [HERE, THERE, "runtime-other-win"], argv: ["--keep-runtime", HERE],
        error: /not the known fault/ },
      { name: "non-runtime value", initial: [HERE, THERE], argv: ["--keep-runtime", "type-observation"],
        error: /--keep-runtime takes a runtime- label/, noRequest: true },
      { name: "with --labels", initial: [HERE, THERE], argv: ["--keep-runtime", HERE, "--labels", "alpha"],
        error: /--keep-runtime cannot be combined/, noRequest: true },
      { name: "with --remove", initial: [HERE, THERE], argv: ["--remove", "alpha", "--keep-runtime", HERE],
        error: /--keep-runtime cannot be combined/, noRequest: true },
    ];
    for (const { name, initial, argv, error, noRequest } of cases) {
      const { err, calls, injected } = harness({ env: LABEL_ENV, api: labelPage(initial) });
      assert.equal(await runCli(["labels", "--id", "5001", ...argv], injected), 1, name);
      assert.deepEqual(labelWrites(calls), [], `${name} wrote a label`);
      if (noRequest) assert.deepEqual(calls, [], `${name} sent a request`);
      assert.match(err.join("\n"), error, name);
    }
  });

  test(`${BROKER} help names the --keep-runtime repair flag`, async () => {
    const { out, injected } = harness();
    assert.equal(await runCli(["help"], injected), 0);
    assert.ok(out.includes("  labels --id <id> [--labels <a,b>] [--remove <a,b>] [--keep-runtime <runtime-label>]"),
      out.join("\n"));
  });
}
