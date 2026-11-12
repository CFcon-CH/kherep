// #838 A4 source guard: service/last-failure.json is display-only. Only `service status` and `doctor` read it; the
// CLI only writes and removes it; no transaction, recovery, drain, admission, supervisor or adapter file touches it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const here = import.meta.dirname;
const sources = [here, path.dirname(here)].flatMap(dir => fs.readdirSync(dir)
  .filter(name => name.endsWith(".mts") && !name.endsWith(".test.mts") && !/fixture/.test(name))
  .map(name => ({ name: path.relative(here, path.join(dir, name)), text: fs.readFileSync(path.join(dir, name), "utf8") })));
const importers = (module: string) => sources.filter(file => new RegExp(`from "\\./${module.replace(".", "\\.")}"`).test(file.text)).map(file => file.name).sort();

test("only the CLI, service status and doctor import the last-failure module", () => {
  assert.ok(sources.length > 50, "the source listing is complete");
  assert.deepEqual(importers("service-last-failure.mts"), ["doctor-service.mts", "service-cli.mts", "service-status.mts"]);
});

test("the record is read only by the two display paths and its file name is built in one place", () => {
  const readers = sources.filter(file => file.text.includes("readServiceLastFailure")).map(file => file.name).sort();
  assert.deepEqual(readers, ["doctor-service.mts", "service-last-failure.mts", "service-status.mts"]);
  const named = sources.filter(file => /["'`]last-failure\.json["'`]/.test(file.text)).map(file => file.name);
  assert.deepEqual(named, ["service-last-failure.mts"]);
  const cli = sources.find(file => file.name === "service-cli.mts")!.text;
  assert.match(cli, /import \{ lastFailureOf, removeServiceLastFailure, writeServiceLastFailure, type ServiceLastFailure \} from "\.\/service-last-failure\.mts";/);
});

test("the display paths keep the record out of every verdict they print", () => {
  const status = sources.find(file => file.name === "service-status.mts")!.text;
  assert.equal((status.match(/lastFailureReport\(/g) ?? []).length, 1, "one use, in the printed report");
  assert.match(status, /\.\.\.lastFailureReport\(paths\) \};\n {2}console\.log/);
  assert.equal((status.match(/readServiceLastFailure\(/g) ?? []).length, 1);
  const doctor = sources.find(file => file.name === "doctor-service.mts")!.text;
  assert.match(doctor, /return \{ ok: node === "running", managed: true, node, drain,/);
  assert.doesNotMatch(doctor, /serviceNodeState\([^)]*(record|lastFailure)/);
});
