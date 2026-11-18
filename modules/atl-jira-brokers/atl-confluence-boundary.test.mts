// Issue #965: branches both Confluence brokers share - --body-file on update, purge, delete readback,
// a page without a version - plus each CLI boundary run as a process. One suite, both brokers: a
// property that holds on one broker by accident is not a property. Synthetic values, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { runCli as claudeCli, type Injected } from "./atl-confluence-ccoder.mts";
import { runCli as codexCli } from "./atl-confluence.mts";
import { reply, routed, type Route } from "./broker-route.fixture.mts";

const SITE = "https://wiki.example.com";
const CRED_PATH = "synthetic-credential-path";
const BODY_PATH = "synthetic-body.xml";
const PAGE = { id: "5001", title: "Page", status: "current", spaceId: "9001", authorId: "app", version: { number: 3 } };
const TRASHED = { ...PAGE, status: "trashed" };

const BROKERS = [
  { name: "atl-confluence-ccoder.mts", env: "KHEREP_ATL_CRED_FILE_CLAUDE", cli: claudeCli },
  { name: "atl-confluence.mts", env: "KHEREP_ATL_CRED_FILE_CODEX", cli: codexCli },
];

function harness(broker: (typeof BROKERS)[number], routes: Route[], files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const known: Record<string, string> = { [CRED_PATH]: "Client ID: synthetic-client\nSecret: synthetic-secret-1234\n", ...files };
  const { calls, fetchImpl } = routed(routes, [
    ["POST", /auth\.atlassian\.com/, reply(200, { access_token: "synthetic-token", expires_in: 3600 })],
    ["GET", /_edge\/tenant_info$/, reply(200, { cloudId: "synthetic-cloud" })],
  ]);
  const injected: Injected = {
    env: { KHEREP_ATL_SITE: SITE, [broker.env]: CRED_PATH },
    readFile: async (file: string) => {
      if (!(file in known)) throw new Error("ENOENT synthetic");
      return known[file];
    },
    fetch: fetchImpl,
    log: (line) => { out.push(line); },
    logError: (line) => { err.push(line); },
    now: () => 1_000_000,
    writeOut: () => { throw new Error("no payload expected"); },
  };
  return { out, err, calls, run: (argv: string[]) => broker.cli(argv, injected) };
}

const pageGet = (body: unknown, status = 200): Route => ["GET", /\/wiki\/api\/v2\/pages\/5001(\?|$)/, reply(status, body)];

for (const broker of BROKERS) {
  test(`${broker.name} update sends the --body-file content and refuses an unreadable one unnamed`, async () => {
    const h = harness(broker, [pageGet(PAGE), ["PUT", /\/pages\/5001$/, reply(200, { ...PAGE, version: { number: 4 } })]],
      { [BODY_PATH]: "<p>aus Datei</p>" });
    assert.equal(await h.run(["update", "--id", "5001", "--format", "storage", "--body-file", BODY_PATH]), 0, h.err.join("\n"));
    const put = h.calls.find((call) => call.method === "PUT");
    assert.equal(JSON.parse(put?.body ?? "{}").body.value, "<p>aus Datei</p>");

    const missing = harness(broker, []);
    assert.equal(await missing.run(["update", "--id", "5001", "--format", "storage", "--body-file", "synthetic-missing.xml"]), 1);
    assert.deepEqual(missing.err, ["--body-file is not readable."]);
    assert.equal(missing.calls.length, 0);
  });

  test(`${broker.name} update refuses a page that reports no version number`, async () => {
    const h = harness(broker, [pageGet({ ...PAGE, version: {} })]);
    assert.equal(await h.run(["update", "--id", "5001", "--format", "storage", "--body", "x"]), 1);
    assert.deepEqual(h.err, ["Page 5001 reported no version number; refusing to invent one."]);
    assert.equal(h.calls.some((call) => call.method === "PUT"), false);
  });

  test(`${broker.name} guarded update refuses a current page whose identity is malformed`, async () => {
    const h = harness(broker, [pageGet({ ...PAGE, status: "draft" })]);
    assert.equal(await h.run(["update", "--id", "5001", "--format", "storage", "--body", "x", "--expected-version", "3"]), 1);
    assert.deepEqual(h.err, ["Malformed current page identity; guarded update refused."]);
    assert.equal(h.calls.some((call) => call.method === "PUT"), false);
  });

  test(`${broker.name} purges a trashed page with the purge flag`, async () => {
    const h = harness(broker, [pageGet(TRASHED), ["DELETE", /\/pages\/5001\?purge=true$/, reply(204)]]);
    assert.equal(await h.run(["purge", "--id", "5001"]), 0, h.err.join("\n"));
    assert.deepEqual(h.out, ["purged: the page is permanently removed."]);
    assert.equal(h.calls.filter((call) => call.method === "DELETE").length, 1);
  });

  test(`${broker.name} refuses a purge it cannot read, without claiming the page is gone`, async () => {
    const h = harness(broker, [pageGet({ errors: [] }, 404)]);
    assert.equal(await h.run(["purge", "--id", "5001"]), 1);
    assert.match(h.err.join("\n"), /cannot be read, so purge is refused/);
    assert.equal(h.calls.some((call) => call.method === "DELETE"), false);

    const broken = harness(broker, [pageGet({}, 500)]);
    assert.equal(await broken.run(["purge", "--id", "5001"]), 1);
    assert.doesNotMatch(broken.err.join("\n"), /purge is refused/);
    assert.equal(broken.calls.some((call) => call.method === "DELETE"), false);
  });

  test(`${broker.name} delete says so when the trashed page cannot be read back`, async () => {
    const h = harness(broker, [["DELETE", /\/pages\/5001$/, reply(204)], pageGet({}, 404)]);
    assert.equal(await h.run(["delete", "--id", "5001"]), 0, h.err.join("\n"));
    assert.equal(h.out.at(-1), "readback status: the page is no longer readable");
  });

  const file = path.join(import.meta.dirname, broker.name);
  const env = { PATH: process.env.PATH ?? "" };

  test(`${broker.name} run as a process prints help, and exits 1 on an unknown verb`, () => {
    const help = spawnSync(process.execPath, [file, "help"], { encoding: "utf8", timeout: 20_000, env });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /selftest/);
    const unknown = spawnSync(process.execPath, [file, "nonsense"], { encoding: "utf8", timeout: 20_000, env });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /^Usage: /);
  });

  test(`${broker.name} imported without its own script path stays a library and prints nothing`, () => {
    // No script path at all, and one that does not exist: neither may run the entry point.
    for (const argv of [[], [path.join(os.tmpdir(), `kherep-absent-${process.pid}`, "entry.mts")]]) {
      const proc = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(file)});`, ...argv], {
        encoding: "utf8", timeout: 20_000, env,
      });
      assert.equal(proc.status, 0);
      assert.equal(proc.stdout, "");
    }
  });
}
