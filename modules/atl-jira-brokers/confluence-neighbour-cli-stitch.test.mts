// Issue #965: stitch through the broker CLI from candidates to written link - the receipt is written as
// a new file in a temporary directory, the decisions file approves one candidate, and the write goes
// through the neighbour context's update path. Route-table fetch and synthetic values only.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "./atl-confluence-ccoder.mts";
import { reply, routed, type Route } from "./broker-route.fixture.mts";

const CRED_PATH = "synthetic-credential-path";
const PAGES = [
  { id: "100", title: "Shelf", spaceId: "9001", parentId: null },
  { id: "101", title: "Token cache rules", spaceId: "9001", parentId: "100" },
  { id: "102", title: "Token expiry gotcha", spaceId: "9001", parentId: "100" },
];
const ROUTES: Route[] = [
  ["GET", /\/spaces\?keys=KB$/, reply(200, { results: [{ id: "9001", key: "KB", name: "Knowledge" }] })],
  ["GET", /\/spaces\/9001\/pages\?limit=250&status=current$/, reply(200, { results: PAGES })],
  ["GET", /\/rest\/api\/search\?cql=/, reply(200, { results: [] })],
  ["GET", /\/pages\/\d+\?body-format=storage$/, reply(200, { body: { storage: { value: "<p>body</p>" } } })],
  ["GET", /\/pages\/102$/, reply(200, { id: "102", title: "Token expiry gotcha", status: "current", spaceId: "9001", version: { number: 4 } })],
  ["PUT", /\/pages\/102$/, reply(200, { id: "102", title: "Token expiry gotcha", status: "current", version: { number: 5 } })],
];

function harness(home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const { calls, fetchImpl } = routed(ROUTES, [
    ["POST", /auth\.atlassian\.com/, reply(200, { access_token: "synthetic-token", expires_in: 3600 })],
    ["GET", /_edge\/tenant_info$/, reply(200, { cloudId: "synthetic-cloud" })],
  ]);
  const run = (argv: string[]) => runCli(argv, {
    env: { KHEREP_ATL_SITE: "https://wiki.example.com", KHEREP_ATL_CRED_FILE_CLAUDE: CRED_PATH },
    // The credential is synthetic; receipt and decisions are the files this test put in its own directory.
    readFile: async (file: string) => {
      if (file === CRED_PATH) return "Client ID: synthetic-client\nSecret: synthetic-secret-1234\n";
      if (!path.resolve(file).startsWith(home)) throw new Error("ENOENT synthetic");
      return fs.promises.readFile(file, "utf8");
    },
    fetch: fetchImpl,
    log: (line) => { out.push(line); },
    logError: (line) => { err.push(line); },
    now: () => Date.parse("2026-11-18T10:00:00Z"),
    semantic: async () => ({ titles: ["Token expiry gotcha"] }),
    writeOut: () => { throw new Error("no payload expected"); },
  });
  return { out, err, calls, run };
}

test("stitch writes a receipt, then links the approved candidate through the update path", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stitch-cli-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const receipt = path.join(home, "candidates.json");

  const searched = harness(home);
  assert.equal(await searched.run(["stitch", "--space", "KB", "--id", "101", "--topic", "token expiry handling", "--out", receipt]), 0,
    searched.err.join("\n"));
  assert.ok(fs.existsSync(receipt));
  assert.ok(searched.out.some((line) => line.startsWith("candidate\t102\t")), searched.out.join("\n"));
  assert.equal(searched.calls.some((call) => call.method === "PUT"), false);

  const decisions = path.join(home, "decisions.txt");
  fs.writeFileSync(decisions, "102\tBoth pages describe the token expiry handling.\n");
  const written = harness(home);
  assert.equal(await written.run(["stitch", "--space", "KB", "--id", "101", "--candidates", receipt, "--decisions", decisions]), 0,
    written.err.join("\n"));
  const put = written.calls.filter((call) => call.method === "PUT");
  assert.equal(put.length, 1);
  const body = JSON.parse(put[0].body ?? "{}");
  assert.match(body.body.value, /pages\/101/);
  assert.equal(body.version.number, 5);
  assert.ok(written.out.includes("pages written: 1"));
});

test("stitch candidates refuse an id that is not a page of the space, and write mode an unreadable receipt", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stitch-cli-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const unknown = harness(home);
  assert.equal(await unknown.run(["stitch", "--space", "KB", "--id", "999", "--topic", "token expiry handling", "--out", path.join(home, "r.json")]), 1);
  assert.deepEqual(unknown.err, ["That id is not a page in this space."]);
  assert.equal(fs.existsSync(path.join(home, "r.json")), false);

  const unreadable = harness(home);
  assert.equal(await unreadable.run(["stitch", "--space", "KB", "--id", "101", "--candidates", path.join(home, "absent.json"),
    "--decisions", path.join(home, "absent.txt")]), 1);
  assert.deepEqual(unreadable.out, ["refused\t101\t--candidates is not readable"]);
  assert.deepEqual(unreadable.err, ["Nothing was written."]);
  assert.equal(unreadable.calls.some((call) => call.method === "PUT"), false);
});
