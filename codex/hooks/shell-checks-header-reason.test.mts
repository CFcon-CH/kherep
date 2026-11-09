// Issue #700. Codex parity of the denied-call reason line: the shell dispatcher runs the real
// commit-guard, installed from claude/hooks with its lib as codex/install.mts lays it out, and
// the journal records the guard's first violation, not its header line.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { journalPaths } from "../../claude/hooks/lib/denial-journal.mts";
import { readJournal, renderReport } from "../../claude/hooks/lib/denial-report.mts";
import { cleanupHomes, codexHome, run, shellPayload } from "./denials-fixture.mts";

after(cleanupHomes);
const CLAUDE_HOOKS = path.resolve(import.meta.dirname, "..", "..", "claude", "hooks");
const EM_DASH = "commit message contains an em dash (U+2014)";

test("the real commit-guard through the Codex shell dispatcher: the em dash violation is the reason", async () => {
  const guard = fs.readFileSync(path.join(CLAUDE_HOOKS, "commit-guard.mts"), "utf8");
  const home = codexHome({ "commit-guard.mts": guard, "deploy-guard.mts": "process.exit(0);\n", "main-checkout-guard.mts": "process.exit(0);\n", "module-label-guard.mts": "process.exit(0);\n" });
  fs.copyFileSync(path.join(CLAUDE_HOOKS, "lib", "git-commit-match.mts"), path.join(home.hookDir, "lib", "git-commit-match.mts"));
  const env = { ...process.env };
  for (const name of ["KHEREP_WORK_ITEM_REQUIRED", "KHEREP_DENIAL_FAULT", "KHEREP_DENIAL_FAULT_MAIN"]) delete env[name];
  const commit = { tool_input: { command: "git commit -m \"x \u2014 y\n\nCo-authored-by: Example <dev@example.com>\"" } };
  const shell = (input: string) => run([path.join(home.hookDir, "codex-shell-checks.mts")], input, env);
  const attributed = await shell(shellPayload({ agent_id: undefined, tool_input: { command: "git commit -m \"plain subject\n\nCo-authored-by: Codex <codex@example.com>\"" } }));
  assert.equal(attributed.status, 0, attributed.stderr);
  assert.doesNotMatch(attributed.stdout, /"permissionDecision":"deny"/);
  const plain = await shell(shellPayload({ ...commit, agent_id: undefined }));
  const delegated = await shell(shellPayload(commit));
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(delegated.stdout, plain.stdout, "capture never changes the decision");
  assert.match(delegated.stdout, /"permissionDecision":"deny"/);
  const [line] = fs.readFileSync(journalPaths(home.root, "agent-c1").journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(line.denials.map((d: { guard: string; reason: string }) => [d.guard, d.reason]), [["commit-guard", EM_DASH]]);
  const rendered = renderReport(readJournal(home.root, "agent-c1")).text.split("\n");
  assert.equal(rendered[0], "DENIED-CALLS: 1");
  assert.equal(rendered[1], `- shell_command git [commit-guard] ${EM_DASH}`);
  assert.ok(!rendered.join("\n").includes("blocked this commit"), rendered.join("\n"));
});
