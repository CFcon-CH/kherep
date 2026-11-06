// Issue #701. A worker brief binds build and review work to a revision. The
// guards check the brief markers; this test pins the parts no guard checks: the
// rule text, the reviewer rule, the receipt lines, the roles both runtimes treat
// as code-bound, the grammar copied from the observation lib and the size caps.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { CODE_BOUND_AGENTS } from "../claude/hooks/lib/dispatch-policy.mts";
import { REVIEW_ASSUMPTION_RULE } from "../claude/hooks/lib/worker-brief-policy.mts";
import { renderAgent } from "../codex/lib/component-render.mts";
import type { Capabilities } from "../codex/lib/contracts.mts";
import { agentSourcePath } from "../codex/lib/parity-projection.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(REPO, relative), "utf8");
const ROUTING_FILES = ["claude/teams/kherep/ROUTING.md", "codex/ROUTING.md"];
const capabilities = JSON.parse(read("codex/parity/capabilities.json")) as Capabilities;

function section(file: string, heading: string): string {
  const text = read(file);
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `${file} has a ${heading} section`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? text.length : end);
}

test("both Dispatch sections define the markers, the review receipt and the reviewer rule verbatim", () => {
  for (const file of ROUTING_FILES) {
    const text = section(file, "Dispatch");
    for (const needle of ["`revision: <name>@<sha>`", "`<name>@<base>..<head>`", "`-dirty`", "`decided: <decision", "`decided: none`",
      "`REVISION: <name>@<base>..<head>[-dirty]`", "`ASSUMED: none | <n>`", "`kherep-builder` and `dc-plugin-build-runner`",
      "reads no git state", "`codex exec`", "Control Plane intercom", "retired plugin agent is denied", "`reviewer`"]) {
      assert.ok(text.includes(needle), `${file}: ${needle}`);
    }
    assert.ok(text.includes(`\n> ${REVIEW_ASSUMPTION_RULE}\n`), `${file}: the reviewer rule verbatim`);
  }
  const claude = section(ROUTING_FILES[0], "Dispatch");
  for (const rule of ["`WORKER_BRIEF_FORMAT`", "`WORKER_BRIEF_REVISION`"]) assert.ok(claude.includes(rule), rule);
});

test("both Verification sections name the Revision receipt line and the C4 rule", () => {
  for (const file of ROUTING_FILES) {
    const text = section(file, "Verification");
    for (const needle of ["`Revision: bound <name>@<sha> | mismatch <name> (brief <sha7>, receipt <sha7>) | unknown (no-receipt-line)`",
      "the base of a `<base>..<head>` receipt", "fails C4", "UNKNOWN in acceptance and never bound"]) {
      assert.ok(text.includes(needle), `${file}: ${needle}`);
    }
  }
});

test("both code-bound agents carry REVISION in their receipt, in Claude and in the Codex projection", () => {
  const builder = read("claude/agents/kherep-builder.md");
  const receipt = /```text\n([\s\S]*?)```/.exec(builder)?.[1] ?? "";
  assert.match(receipt, /^REVISION: <name>@<sha>\[-dirty\] \| <name>@<base>\.\.<head>$/m);
  assert.match(read("claude/agents/dc-plugin-build-runner.md"), /^Return `RESULT`, `SOURCE`, `REVISION`, /m);
  for (const [name, needle] of [["kherep-builder", "REVISION: <name>@<sha>[-dirty]"], ["dc-plugin-build-runner", "`REVISION`"]] as const) {
    const options = capabilities.agents[name];
    const toml = renderAgent(options.as || name, fs.readFileSync(agentSourcePath(REPO, name, options), "utf8"), options);
    assert.ok(toml.includes(needle), name);
  }
});

test("both runtimes treat the same roles as code-bound", () => {
  const manifest = Object.entries(capabilities.agents).filter(([, entry]) => entry.codeBound === true)
    .map(([name, entry]) => entry.as || name);
  assert.deepEqual(manifest.sort(), [...CODE_BOUND_AGENTS].sort());
  assert.deepEqual([...CODE_BOUND_AGENTS].sort(), ["dc-plugin-build-runner", "kherep-builder"]);
});

test("the worker lib copies NAME and SHA of the observation lib literally", () => {
  const literal = (file: string, name: string) => new RegExp(`^const ${name} = (.+);$`, "m").exec(read(file))?.[1];
  for (const name of ["NAME", "SHA"]) {
    const observation = literal("claude/hooks/lib/obs-brief-policy.mts", name);
    assert.ok(observation, name);
    assert.equal(literal("claude/hooks/lib/worker-brief-policy.mts", name), observation, name);
  }
});

test("the files of this contract stay within 250 lines", () => {
  for (const file of ["claude/agents/kherep-builder.md", "claude/agents/dc-plugin-build-runner.md", "claude/hooks/lib/worker-brief-policy.mts",
    "claude/hooks/dispatch-contract-guard.mts", "codex/hooks/dispatch-contract-guard.mts", "bootstrap/worker-brief-contract.test.mts"]) {
    assert.ok(read(file).split("\n").length <= 251, `${file} has at most 250 lines`);
  }
});

test("build routing requires a completed lookup before dispatch and pauses unavailable routes", () => {
  for (const file of ROUTING_FILES) {
    const text = section(file, "Dispatch");
    for (const needle of ["Central Brain lookup is always part of build and infrastructure work", "before the first action",
      "dispatcher owns the initial completed lookup", "authoritative project execution documentation", "read-only discovery worker",
      "test-route:", "route-source:", "literal ` :: `", "every occurrence", "terminate a preceding multi-line `decided:`",
      "UNKNOWN", "wait", "tool missing", "permitted availability check", "not proof", "Follow-up assignments"]) {
      assert.ok(text.includes(needle), `${file}: ${needle}`);
    }
  }
});

test("both builder source contracts and Codex projections preserve the lookup and failure procedure", () => {
  for (const name of ["kherep-builder", "dc-plugin-build-runner"]) {
    const source = read(`claude/agents/${name}.md`);
    const options = capabilities.agents[name];
    const projected = renderAgent(options.as || name, source, options);
    for (const text of [source, projected]) {
      for (const needle of ["test-route:", "route-source:", "Central Brain", "before the first action", "dispatcher",
        "revision and execution context", "UNKNOWN", "wait", "tool missing", "permitted availability check",
        "follow-up", "VERIFY"]) assert.ok(text.includes(needle), `${name}: ${needle}`);
    }
  }
});

test("both installed adapters ship the same shared worker parser", () => {
  assert.ok(read("bootstrap/manifest/files.txt").includes("hooks/lib/worker-brief-policy.mts"));
  assert.ok(read("codex/install.mts").includes('transaction.installDir(path.join(sources.claudeHooks, "lib"), path.join(targets.hookDir, "lib"))'));
});
