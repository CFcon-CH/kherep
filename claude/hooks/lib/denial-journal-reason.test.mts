// Issue #700. The reason line a denial records: a guard that prints a header ending in `:` and
// then its violations records the first violation without its list marker; every other reason
// keeps its first non-empty line. Path reduction, the private-marker refusal and the 240 cut
// apply to the chosen line, and the refusal also to the skipped header. The guard tag still
// comes from the first line.
import assert from "node:assert/strict";
import { test } from "node:test";

import { callLine, guardOf, PRIVATE_MARKER_PATTERN, redactReason, WITHHELD } from "./denial-journal.mts";

// A marker term taken from the pattern itself, so this file names none.
const MARK = PRIVATE_MARKER_PATTERN.source.split("|").pop()!;
const EM_DASH = "commit message contains an em dash (U+2014)";
// Verbatim shapes of claude/hooks/commit-guard.mts and deploy-guard.mts.
const COMMIT = `commit-guard blocked this commit:\n  - ${EM_DASH}\n`;
const DEPLOY = "deploy-guard blocked this command:\n  - first violation\n  - second violation\n\nRe-run with the approval marker.\n";
const bash = { agent_id: "a1", tool_use_id: "toolu_1", tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: "/w" };

test("U1: a commit-guard denial records its violation, the tag stays commit-guard", () => {
  const text = callLine(bash, [{ decision: "deny", reason: COMMIT }]);
  assert.deepEqual(JSON.parse(text).denials, [{ guard: "commit-guard", target: "git", reason: EM_DASH, broken: false }]);
  assert.ok(!text.includes("blocked this commit"), text);
  assert.equal(guardOf(COMMIT), "commit-guard");
});

test("U2: only the first violation is recorded, no count suffix, the advice paragraph never", () => {
  assert.equal(redactReason(DEPLOY), "first violation");
  assert.equal(guardOf(DEPLOY), "deploy-guard");
  assert.equal(redactReason("x blocked:\r\n  - crlf violation\r\n"), "crlf violation");
});

test("U3: absolute paths in the chosen line are reduced to their basename", () => {
  assert.equal(redactReason("cannot read /home/u/repo/file.mts.,;: now"), "cannot read file.mts.,;: now");
  assert.equal(redactReason("deploy-guard blocked this command:\n  - cannot write /home/u/repo/out.txt"), "cannot write out.txt");
  assert.equal(redactReason("deploy-guard blocked this command:\n  - cannot write C:\\Users\\u\\repo\\out.txt now"), "cannot write out.txt now");
  assert.equal(redactReason("g blocked in /home/u/repo:\n  - plain"), "plain");
});

test("U4: a marker in the chosen line or in the skipped header is <withheld>", () => {
  assert.equal(redactReason(`g blocked this command:\n  - path with ${MARK} inside`), WITHHELD);
  assert.equal(redactReason(`g blocked ${MARK} here:\n  - clean violation`), WITHHELD);
  assert.equal(redactReason(`g blocked this command:\n  - clean violation\n  - later ${MARK}`), "clean violation");
});

test("U5: list markers -, * and the bullet sign are removed; a line without one stays", () => {
  for (const marker of ["- ", "* ", "\u2022 "]) assert.equal(redactReason(`g blocked:\n  ${marker}violation`), "violation", JSON.stringify(marker));
  assert.equal(redactReason("g blocked:\n  violation"), "violation");
  assert.equal(redactReason("g blocked:\n  -violation"), "-violation", "a dash without a following space is no list marker");
});

test("single-line reasons and headerless multi-line reasons keep their first line", () => {
  assert.equal(redactReason("[x] one line"), "[x] one line");
  assert.equal(redactReason("x blocked this command:"), "x blocked this command:", "a lone header is kept");
  assert.equal(redactReason("x blocked this command:\n\n"), "x blocked this command:", "trailing empty lines do not count");
  assert.equal(redactReason("[exit2-guard] exit2 says no\nsecond line"), "[exit2-guard] exit2 says no");
  assert.equal(redactReason("[secret-output-guard] BLOCKED (id): output held\n\nparagraph:"), "[secret-output-guard] BLOCKED (id): output held");
  assert.equal(redactReason("\n\n  first non-empty\nsecond"), "first non-empty");
  assert.equal(redactReason(""), "");
});

test("the 240 cut applies to the chosen line", () => {
  const reason = redactReason(`g blocked:\n  - ${"v".repeat(300)}`);
  assert.equal(reason, "v".repeat(240));
});
