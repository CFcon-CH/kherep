// #731 PR-A pins configured interpretation; it does not execute an agent or publish.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
const root = path.resolve(import.meta.dirname, "..");
const files = ["claude/agents/claude-obs.md", "codex/agents/codex-obs.md", "claude/teams/kherep/ROUTING.md", "codex/ROUTING.md"];
const texts = files.map(file => fs.readFileSync(path.join(root, file), "utf8"));
const contract = (text: string) => text.split("<!-- observation-claim-scopes:start -->")[1]?.split("<!-- observation-claim-scopes:end -->")[0];

test("all four actual contracts share the claim decision table", () => {
  const section = contract(texts[0]);
  assert.ok(section, "the scope contract exists");
  for (const [i, text] of texts.entries()) assert.equal(contract(text), section, files[i]);
  for (const scope of ["live", "doc", "tracker", "code", "refused"]) assert.ok(section.includes(`\`${scope}\``), scope);
});

test("the original live comparison stays narrow and code laundering stays under #505", () => {
  for (const text of texts) {
    assert.match(text, /27 sampled served image bodies/);
    assert.match(text, /target, time and sample/);
    assert.match(text, /Mentioning code or a commit.*does not change/);
    assert.match(text, /Code correctness, test\/build results or general implementation behavior.*#505/);
    assert.match(text, /marker cannot launder/);
    assert.match(text, /reading a report confirms its content, not the reported measurement/);
  }
});

test("installed proof binds exercised bytes and closure without guessing clean source", () => {
  for (const text of texts) {
    assert.match(text, /installed public copy remains `code`/);
    assert.match(text, /full source revision and repo-relative paths/);
    assert.match(text, /before and after.*immutable verified fixture/);
    assert.match(text, /dependency closure/);
    assert.match(text, /Dirty, unbound or mismatched.*`assumed`/);
    assert.match(text, /No private scan/);
  }
});

test("actual refusal proves only refusal and cannot invent an unexecuted result", () => {
  for (const text of texts) {
    assert.match(text, /actual same-turn guard\/native event/);
    assert.match(text, /check-ref: public-policy#safe-host-check/);
    assert.match(text, /Never confirm.*unexecuted command/);
    assert.match(text, /historical denial, echo.*`assumed`/);
    assert.match(text, /omit unsafe command text entirely/);
    assert.match(text, /Syntax is not execution evidence/);
  }
});
