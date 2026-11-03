// Issue #302. The Jira broker set is optional, but presence decides what
// drift-check compares: a host that has any member of the set is checked like a
// flagged one, so a stale broker cannot hide behind a missing switch. A host
// without the set passes with one informational NOT-INSTALLED line, and files
// that only resemble a member never count as present.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { observationFiles } from "../codex/lib/observation-projection.mts";

const HERE = import.meta.dirname;
const BROKERS = path.join(HERE, "..", "modules", "atl-jira-brokers");
const SHARED_JIRA_MODULES = fs.readdirSync(BROKERS)
  .filter((name) => name.startsWith("jira-") && name.endsWith(".mts") && !name.endsWith(".test.mts"))
  .sort();
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);

interface Fixture { home: string; claude: string; ws: string; creds: string; tools: string }

function fixture(t: { after: (fn: () => void) => void }): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-302-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const ws = path.join(root, "workspace");
  const f = { home, claude: path.join(home, ".claude"), ws, creds: path.join(root, "credentials"),
    tools: path.join(ws, "tools") };
  for (const dir of [f.claude, path.join(f.ws, ".claude"), f.creds]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(f.claude, "settings.json"), "{}\n");
  fs.writeFileSync(path.join(f.ws, ".claude", "settings.local.json"), "{}\n");
  return f;
}

function run(script: string, f: Fixture, extra: Record<string, string> = {}): { status: number | null; out: string } {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
  const env = { ...base, HOME: slash(f.home), CLAUDE_HOME: slash(f.claude), KHEREP_PROFILE: "win",
    KHEREP_WORKSPACE: slash(f.ws), KHEREP_CREDENTIALS_ROOT: slash(f.creds), KHEREP_INSTALL_SKIP_GITCONFIG: "1",
    KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE: "1", KHEREP_INSTALL_SKIP_ATL_CREDENTIAL: "1", SKIP_SECRETS: "1",
    SKIP_DEPS: "1", ...extra };
  const result = spawnSync("bash", [slash(path.join(HERE, script))], { encoding: "utf8", env, timeout: 240_000 });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

function install(f: Fixture, extra: Record<string, string> = {}): void {
  const result = run("install.sh", f, extra);
  assert.equal(result.status, 0, result.out);
}

test("a stale Jira broker from a flagged install is drift even without the flag", (t) => {
  const f = fixture(t);
  install(f, { KHEREP_INSTALL_ATLASSIAN_TOOLS: "1" });
  fs.appendFileSync(path.join(f.tools, "atl-jira.mts"), "// stale\n");
  const drift = run("drift-check.sh", f);
  assert.equal(drift.status, 1, drift.out);
  assert.match(drift.out, /^DRIFT +project\/tools\/atl-jira\.mts$/m);
  assert.match(drift.out, /^ok +project\/tools\/atl-jira-ccoder\.mts$/m);
  assert.doesNotMatch(drift.out, /^NOT-INSTALLED +project\/tools\/<Jira set>/m);
  assert.match(drift.out, /^DRIFT-CHECK FOUND DRIFT \(see above\)$/m);
});

test("a partial Jira set reports its absent members as missing", (t) => {
  const f = fixture(t);
  install(f);
  fs.copyFileSync(path.join(BROKERS, "atl-jira.mts"), path.join(f.tools, "atl-jira.mts"));
  const drift = run("drift-check.sh", f);
  assert.equal(drift.status, 1, drift.out);
  assert.match(drift.out, /^ok +project\/tools\/atl-jira\.mts$/m);
  assert.ok(SHARED_JIRA_MODULES.length >= 5, `found only ${SHARED_JIRA_MODULES.join(", ")}`);
  for (const name of ["atl-jira-ccoder.mts", ...SHARED_JIRA_MODULES]) {
    assert.match(drift.out, new RegExp(`^MISSING-LIVE +project/tools/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "m"), name);
  }
});

test("without the Jira set or the flag the check passes and names the set once", (t) => {
  const f = fixture(t);
  install(f);
  fs.writeFileSync(path.join(f.tools, "atl-jira.mjs"), "decoy\n");
  fs.writeFileSync(path.join(f.tools, "atl-jira.mts.bak-20261007"), "decoy\n");
  fs.writeFileSync(path.join(f.tools, "jira-adf.test.mjs"), "decoy\n");
  fs.mkdirSync(path.join(f.tools, "_deprecated"));
  fs.writeFileSync(path.join(f.tools, "_deprecated", "old.mts"), "decoy\n");
  fs.writeFileSync(path.join(f.tools, "_deprecated", "atl-jira.mts"), "decoy\n");
  const drift = run("drift-check.sh", f);
  assert.equal(drift.status, 0, drift.out);
  assert.match(drift.out, /^DRIFT-CHECK PASS \(repo == live\)$/m);
  const allLines = drift.out.split(/\r?\n/);
  const notInstalled = allLines.filter((line) => line.startsWith("NOT-INSTALLED "));
  assert.deepEqual(notInstalled.map((line) => /<(\w+) set>/.exec(line)?.[1]), ["Jira", "observation"], drift.out);
  for (const line of notInstalled) assert.match(line, /^NOT-INSTALLED +project\/tools\/.*\(optional; /);
  // atl-jira.mjs is also a retired path, so its RETIRED-LIVE line (#33) is the
  // one expected mention; no other line may name a decoy.
  assert.match(drift.out, /^RETIRED-LIVE  project\/tools\/atl-jira\.mjs /m, "atl-jira.mjs is not reported as retired");
  const lines = allLines.filter((line) => !line.startsWith("RETIRED-LIVE  project/tools/atl-jira.mjs "));
  for (const decoy of ["atl-jira.mjs", ".bak-", "jira-adf.test.mjs", "_deprecated", "old.mts"]) {
    assert.ok(!lines.some((line) => line.includes(decoy)), `a line names the decoy ${decoy}:\n${drift.out}`);
  }
  assert.doesNotMatch(drift.out, /project\/tools\/(?:atl-)?jira[a-z-]*\.mts/);
});

// The presence list and the twelve literal cmp_file lines name the same set; a
// module added to one but not the other would be compared without counting as
// present, or counted without being compared.
test("the presence list names exactly the compared Jira set", () => {
  const script = fs.readFileSync(path.join(HERE, "drift-check.sh"), "utf8");
  const listed = /^JIRA_TOOLS="([^"]+)"$/m.exec(script)?.[1].split(/\s+/).sort();
  const compared = [...script.matchAll(/^cmp_file "project\/tools\/((?:atl-)?jira[a-z-]*\.mts)"/gm)]
    .map(([, name]) => name).sort();
  assert.equal(compared.length, 12, compared.join(", "));
  assert.deepEqual(listed, compared);
});

// Issue #758. codex/install.mts writes the observation tools; bootstrap/install.sh
// does not, so a Claude-only reinstall left a stale copy behind a passing check.
const observationTools = (script: string): string[] =>
  /^OBSERVATION_TOOLS="([^"]+)"$/m.exec(script)?.[1].split(/\s+/).sort() ?? [];

test("a stale observation tool is drift and names the installer that writes it", (t) => {
  const f = fixture(t);
  install(f);
  const tools = observationTools(fs.readFileSync(path.join(HERE, "drift-check.sh"), "utf8"));
  for (const name of tools) fs.copyFileSync(path.join(BROKERS, name), path.join(f.tools, name));
  assert.equal(run("drift-check.sh", f).status, 0, "a current set is not drift");
  fs.appendFileSync(path.join(f.tools, "observation-linking.mts"), "// stale\n");
  const drift = run("drift-check.sh", f);
  assert.equal(drift.status, 1, drift.out);
  assert.match(drift.out, /^DRIFT +project\/tools\/observation-linking\.mts$/m);
  assert.match(drift.out, /^ok +project\/tools\/observation-stdio\.mts$/m);
  assert.match(drift.out, /^HINT +project\/tools\/observation-\*\.mts: codex\/install\.mts writes these/m);
  assert.match(drift.out, /^DRIFT-CHECK FOUND DRIFT \(see above\)$/m);
});

test("a partial observation set reports its absent members as missing", (t) => {
  const f = fixture(t);
  install(f);
  fs.copyFileSync(path.join(BROKERS, "observation-linking.mts"), path.join(f.tools, "observation-linking.mts"));
  const drift = run("drift-check.sh", f);
  assert.equal(drift.status, 1, drift.out);
  assert.match(drift.out, /^ok +project\/tools\/observation-linking\.mts$/m);
  assert.match(drift.out, /^MISSING-LIVE +project\/tools\/observation-stdio\.mts /m);
});

// The Codex installer computes its file list from the import graph, so a new module
// must not stay outside the check: every member is either in the list or compared above.
test("every tool the Codex installer writes is compared", () => {
  const script = fs.readFileSync(path.join(HERE, "drift-check.sh"), "utf8");
  const listed = observationTools(script);
  const written = observationFiles(path.join(HERE, ".."));
  assert.deepEqual(listed, written.filter((name) => name.startsWith("observation-")).sort());
  for (const name of written.filter((item) => !item.startsWith("observation-"))) {
    assert.ok(script.includes(`modules/atl-jira-brokers/${name}`), `${name} is not compared`);
  }
});
