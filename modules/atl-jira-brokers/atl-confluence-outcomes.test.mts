// Issue #965: what both Confluence brokers print when the site leaves something out - an author, a
// link, a status, an identity - and the create refusals before and after the write. One suite, both
// brokers. Route-table fetch and synthetic values only.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli as claudeCli, type Injected } from "./atl-confluence-ccoder.mts";
import { runCli as codexCli } from "./atl-confluence.mts";
import { reply, routed, sequence, type Route } from "./broker-route.fixture.mts";

const CRED_PATH = "synthetic-credential-path";
const BODY_FILE = "synthetic-observation.xml";
const OBS_BODY = "<p>Finding: x</p><p>Origin: synthetic turn.</p><p>Source: fixture.</p><p>Timestamp: now.</p>";
const UNKNOWN = "UNKNOWN - not reported by the API";
const BROKERS = [
  { name: "atl-confluence-ccoder.mts", env: "KHEREP_ATL_CRED_FILE_CLAUDE", cli: claudeCli,
    create: ["--format", "storage", "--body-file", BODY_FILE, "--labels", "type-observation,evidence-assumed,status-author-model"] },
  { name: "atl-confluence.mts", env: "KHEREP_ATL_CRED_FILE_CODEX", cli: codexCli, create: ["--format", "storage", "--body", OBS_BODY] },
];
const GOOD = reply(200, { access_token: "synthetic-token", expires_in: 3600 });
const TOKEN: Route = ["POST", /auth\.atlassian\.com/, GOOD];
const SPACE: Route = ["GET", /\/spaces\?keys=KB$/, reply(200, { results: [{ id: "9001", key: "KB", name: "Knowledge" }] })];

function harness(broker: (typeof BROKERS)[number], routes: Route[]) {
  const out: string[] = [];
  const err: string[] = [];
  const { calls, fetchImpl } = routed(routes, [TOKEN, ["GET", /_edge\/tenant_info$/, reply(200, { cloudId: "synthetic-cloud" })]]);
  const injected: Injected = {
    env: { KHEREP_ATL_SITE: "https://wiki.example.com", [broker.env]: CRED_PATH },
    readFile: async (file: string) => {
      if (file !== CRED_PATH) throw new Error("ENOENT synthetic");
      return "Client ID: synthetic-client\nSecret: synthetic-secret-1234\n";
    },
    readBodyBytes: async (file: string) => {
      if (file !== BODY_FILE) throw new Error("ENOENT synthetic");
      return Buffer.from(OBS_BODY);
    },
    fetch: fetchImpl,
    log: (line) => { out.push(line); },
    logError: (line) => { err.push(line); },
    now: () => 1_000_000,
    writeOut: () => { throw new Error("no payload expected"); },
  };
  return { out, err, calls, run: (argv: string[]) => broker.cli(argv, injected) };
}

for (const broker of BROKERS) {
  test(`${broker.name} get names a missing author as UNKNOWN and prints no link line`, async () => {
    const h = harness(broker, [["GET", /\/pages\/5001$/, reply(200, { id: "5001", title: "T", status: "current", version: { number: 2 } })]]);
    assert.equal(await h.run(["get", "--id", "5001"]), 0);
    assert.deepEqual(h.out, ["id: 5001", "title: T", "status: current", "version: 2", `authorId: ${UNKNOWN}`]);
  });

  test(`${broker.name} delete names a readback without status as UNKNOWN`, async () => {
    const h = harness(broker, [["DELETE", /\/pages\/5001$/, reply(204)], ["GET", /\/pages\/5001/, reply(200, { id: "5001" })]]);
    assert.equal(await h.run(["delete", "--id", "5001"]), 0);
    assert.equal(h.out.at(-1), `readback status: ${UNKNOWN}`);
  });

  test(`${broker.name} selftest reports an unreadable identity and a non-discriminating check`, async () => {
    const h = harness(broker, [["GET", /\/user\/current$/, reply(403, {})]]);
    assert.equal(await h.run(["selftest"]), 1);
    assert.ok(h.out.includes("account: not reported - this binding cannot read the identity endpoint"), h.out.join("\n"));
  });

  test(`${broker.name} selftest passes and prints an identity without a display name`, async () => {
    const h = harness(broker, [
      // Genuine, tampered, then the session token the identity read uses.
      ["POST", /auth\.atlassian\.com/, sequence(GOOD, reply(401, { error: "access_denied" }), GOOD)],
      ["GET", /\/user\/current$/, reply(200, { accountId: "synthetic-account" })],
    ]);
    assert.equal(await h.run(["selftest"]), 0, [...h.out, ...h.err].join("\n"));
    assert.ok(h.out.includes("account: synthetic-account"));
  });

  test(`${broker.name} create refuses a blank title and an invisible space before writing`, async () => {
    const blank = harness(broker, []);
    assert.equal(await blank.run(["create", "--space", "KB", "--title", "  ", ...broker.create]), 1);
    assert.deepEqual(blank.err, ["--title is missing."]);
    assert.equal(blank.calls.length, 0);

    const hidden = harness(broker, [["GET", /\/spaces\?keys=/, reply(200, { results: [] })]]);
    assert.equal(await hidden.run(["create", "--space", "ZZ", "--title", "T", ...broker.create]), 1);
    assert.deepEqual(hidden.err, ["No space with that key is visible to the service account."]);
    assert.equal(hidden.calls.some((call) => call.method === "POST" && call.url.includes("/wiki/")), false);
  });

  test(`${broker.name} create refuses a write that returns no page id`, async () => {
    const h = harness(broker, [SPACE, ["POST", /\/wiki\/api\/v2\/pages$/, reply(200, { title: "T" })]]);
    assert.equal(await h.run(["create", "--space", "KB", "--title", "T", ...broker.create]), 1);
    assert.deepEqual(h.err, ["create returned no page id, so nothing about it can be verified."]);
  });

  test(`${broker.name} started through a linked directory still runs as the entry point`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "atl-confluence-link-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const linked = path.join(home, "brokers");
    fs.symlinkSync(import.meta.dirname, linked, "junction");
    const proc = spawnSync(process.execPath, [path.join(linked, broker.name), "help"], {
      encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" },
    });
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /selftest/);
  });
}
