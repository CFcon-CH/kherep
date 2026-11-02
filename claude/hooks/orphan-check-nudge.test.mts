#!/usr/bin/env node
// Contract test for orphan-check-nudge.mts. Drives the hook the way Claude Code
// does: JSON on stdin, JSON-or-nothing on stdout, always exit 0.
//
// The assertions that matter are the ones about NOT lying: a report that could
// not measure the space, and a report without a count, must never read like a
// space with no orphans. That distinction is the whole reason this hook exists
// rather than a line in a document.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "orphan-check-nudge.mts");

function withHome(report: string | null, mtimeHoursAgo?: number): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-nudge-"));
  if (report !== null) {
    const dir = path.join(home, ".cache", "orphan-check");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "last-report.txt");
    fs.writeFileSync(file, report);
    if (mtimeHoursAgo) {
      const when = new Date(Date.now() - mtimeHoursAgo * 3_600_000);
      fs.utimesSync(file, when, when);
    }
  }
  return home;
}

// A workspace of the test's own, so scope never depends on the operator's real
// KHEREP_WORKSPACE or on where the checkout happens to live. Every inherited
// KHEREP_* variable is dropped for the same reason (for example a personal
// KHEREP_ORPHAN_MAX_AGE_HOURS would change what counts as stale).
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-nudge-ws-"));

function hookEnv(home: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("KHEREP_")));
  return {
    ...inherited,
    CLAUDE_HOME: home,
    KHEREP_WORKSPACE: WORKSPACE,
    // No refresh in a test: the real one reads an entire live space.
    KHEREP_ORPHAN_AUTOREFRESH: "0",
  };
}

function run(home: string, payload: Record<string, unknown> = { cwd: WORKSPACE }): string {
  return execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: hookEnv(home),
  });
}

const CLEAN = "space: KB\npages: 200\ncount: 0\nexit: 0\n";
const DIRTY = "space: KB\norphan\t1\tA Lonely Page\norphan\t2\tAnother One\npages: 200\ncount: 2\nexit: 1\n";

test("stays silent when the last run was recent and found nothing", () => {
  assert.equal(run(withHome(CLEAN, 1)).trim(), "");
});

test("names the orphans and does not offer to write them itself", () => {
  const out = run(withHome(DIRTY, 1));
  assert.match(out, /2 page\(s\) .* have no incoming link/);
  assert.match(out, /A Lonely Page/);
  // Issue #736: the sweep only lists; writing needs targeted, judged decisions.
  assert.match(out, /lists link candidates per orphan and writes nothing/);
  assert.match(out, /written only by stitch --id with judged decisions/);
  assert.doesNotMatch(out, /WRITES/);
});

test("a report that could not measure is UNKNOWN, never zero", () => {
  const out = run(withHome("space: KB\nexit: 2\nUNMEASURED\n", 1));
  assert.match(out, /UNKNOWN, not zero/);
  assert.doesNotMatch(out, /no orphans/);
});

test("a report without a count is UNKNOWN, not clean", () => {
  const out = run(withHome("space: KB\npages: 200\n", 1));
  assert.match(out, /without a count/);
  assert.match(out, /UNKNOWN/);
});

test("a missing report says nobody has looked, not that nothing is wrong", () => {
  const out = run(withHome(null));
  assert.match(out, /never been checked/);
  assert.doesNotMatch(out, /no orphans/);
});

test("a stale clean report still speaks up", () => {
  const out = run(withHome(CLEAN, 72));
  assert.match(out, /stale/i);
});

test("says nothing outside a kherep workspace", () => {
  assert.equal(run(withHome(DIRTY, 1), { cwd: path.join(os.tmpdir(), "somewhere-else") }).trim(), "");
});

test("exits 0 and prints nothing on malformed input", () => {
  const out = execFileSync(process.execPath, [HOOK], {
    input: "not json",
    encoding: "utf8",
    env: hookEnv(withHome(DIRTY, 1)),
  });
  assert.equal(out.trim(), "");
});

// The nudge is only worth anything if the report it parses is really the shape
// the script writes. This drives the script's own output format, not a fixture.
test("the check script writes the fields the hook reads", () => {
  const script = path.join(HERE, "..", "..", "bootstrap", "orphan-check.sh");
  if (!fs.existsSync(script)) return; // installed copy: the script lives in the checkout
  const text = fs.readFileSync(script, "utf8");
  assert.match(text, /^count=/m, "the hook parses `count:` out of the broker output");
  assert.match(text, /UNMEASURED/, "the hook needs the unmeasured marker to exist");
  assert.match(text, /last-report\.txt/, "the hook reads this exact file");
  // The word appears in the script's own explanation of why it does not do it,
  // so the assertion has to look at what RUNS, not at what the file says.
  const code = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /\bstitch\b/, "the self-triggered check must never invoke the writing verb");
  assert.match(code, /\borphans\b/, "and it must invoke the counting one");
});
