// Issue #965. The Codex hook-integrity hook run from the checkout, outside an install: it reads
// CODEX_HOME, takes run.lock there and reports a config.toml it cannot read or that wires no
// hook file, in the SessionStart JSON form and in the plain --trigger form.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const HOOK = path.join(import.meta.dirname, "hook-integrity.mts");

function box(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-integrity-checkout-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "codex");
  fs.mkdirSync(home);
  const env = { ...process.env, CODEX_HOME: home, CLAUDE_HOME: path.join(root, "no-claude"), KHEREP_WORKSPACE: path.join(root, "no-workspace") };
  const run = (input: string, args: string[] = []) => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", HOOK, ...args], { input, encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { root, home, run };
}

const session = (stdout: string) => JSON.parse(stdout) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };

test("SessionStart without a config.toml: one JSON line, malformed stdin is no payload", (t) => {
  const b = box(t);
  const doc = session(b.run("{not json"));
  const line = "config.toml unreadable (ENOENT), so WHICH hooks are wired is UNKNOWN here";
  assert.equal(doc.systemMessage, `Kherep hook integrity: ${line}`);
  assert.deepEqual(doc.hookSpecificOutput, { hookEventName: "SessionStart", additionalContext: `KHEREP CODEX HOOK-INTEGRITY:\n  - ${line}` });
  assert.equal(fs.existsSync(path.join(b.home, ".cache", "hook-integrity", "heartbeat.json")), false);
});

test("--trigger: a config that wires no hook file under hooks/ writes no heartbeat", (t) => {
  const b = box(t);
  fs.writeFileSync(path.join(b.home, "config.toml"), "[[hooks.Stop.hooks]]\ncommand = '\"node\" \"/elsewhere/hook.mts\"'\n");
  assert.equal(b.run("", ["--trigger", "test"]), "no hook file under hooks/ is wired in config.toml, so WHICH hooks run is UNKNOWN here\n"
    + "heartbeat not written (no wired file)\n");
  assert.equal(fs.existsSync(path.join(b.home, ".cache", "hook-integrity", "heartbeat.json")), false);
  assert.match(b.run("", ["--trigger"]), /^no hook file under hooks\//, "a trigger without a name is accepted");
});

test("SessionStart: two wired files without a versioned source are reported, the first in the system message", (t) => {
  const b = box(t);
  const command = (name: string) => `command = ${JSON.stringify(`"node" "${path.join(b.home, "hooks", name).replace(/\\/g, "/")}"`)}\n`;
  fs.writeFileSync(path.join(b.home, "config.toml"), `[[hooks.Stop.hooks]]\n${command("one.mts")}\n[[hooks.Stop.hooks]]\n${command("two.mts")}`);
  const doc = session(b.run(JSON.stringify({ cwd: b.root })));
  assert.match(doc.systemMessage, /^Kherep hook integrity: one\.mts: .* -> NOT restored, report only \(not installed by Kherep, so there is no versioned source\)\. ENFORCEMENT IS OFF for this hook\. \(\+1 more\)$/);
  const lines = doc.hookSpecificOutput.additionalContext.split("\n");
  assert.equal(lines[0], "KHEREP CODEX HOOK-INTEGRITY:");
  assert.deepEqual(lines.slice(1).map((line) => /^ {2}- (\w+)\.mts: /.exec(line)?.[1]), ["one", "two"]);
});
