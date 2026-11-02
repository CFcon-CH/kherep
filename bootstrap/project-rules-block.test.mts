// OP-1425. The workspace rule files $WS/CLAUDE.md and $WS/AGENTS.md belong to
// the operator. Kherep manages only its marked block inside them. These tests
// pin the five merge cases, idempotence, the drift view of the block, and the
// coexistence with the Codex installer's own AGENTS markers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { setMarkedBlock } from "../codex/lib/text-merge.mts";
import {
  blockBody,
  isKnownTemplate,
  mergeProjectRules,
  PROJECT_RULES_END,
  PROJECT_RULES_START,
} from "./project-rules-block.mts";
import { KNOWN_TEMPLATE_SHA256 } from "./project-rules-history.mts";
import {
  git, historyFixture, LAST_WHOLE_FILE_COMMIT, LEGACY_CUTOFF, LEGACY_TEMPLATE,
  TEMPLATE_PATHS, wholeFileTemplateBlobs,
} from "./project-rules-history-fixture.mts";

const TEMPLATE = "# Kherep working rules\n\n- rule one\n- rule two\n";
const BLOCK = `${PROJECT_RULES_START}\n# Kherep working rules\n\n- rule one\n- rule two\n${PROJECT_RULES_END}`;
const OPERATOR = "# Example Org rules\n\n- keep the synthetic rule\n";
const REPO = path.join(import.meta.dirname, "..");

test("(a) a missing file becomes just the block", () => {
  assert.equal(mergeProjectRules(null, TEMPLATE), `${BLOCK}\n`);
});

test("(b) an existing block is replaced and nothing around it moves", () => {
  const before = `${OPERATOR}\n${PROJECT_RULES_START}\nstale body\n${PROJECT_RULES_END}\n\n## tail kept\n`;
  const merged = mergeProjectRules(before, TEMPLATE);
  assert.equal(merged, `${OPERATOR}\n${BLOCK}\n\n## tail kept\n`);
});

test("(c) an unedited historical template is replaced by the block", () => {
  for (const historical of [LEGACY_TEMPLATE, LEGACY_TEMPLATE.replace(/\n/g, "\r\n")]) {
    assert.ok(isKnownTemplate(historical), "the shipped v0.1.0 whole-file template is known");
    assert.equal(mergeProjectRules(historical, TEMPLATE).replace(/\r\n/g, "\n"), `${BLOCK}\n`);
  }
});

test("edited legacy templates and later reference templates remain operator content", () => {
  const reference = fs.readFileSync(path.join(REPO, "claude", "AGENTS.project.md"), "utf8");
  for (const text of [`${LEGACY_TEMPLATE}\n- synthetic operator addition\n`, reference]) {
    assert.equal(isKnownTemplate(text), false);
    assert.equal(mergeProjectRules(text, TEMPLATE), `${text}\n${BLOCK}\n`);
  }
});

test("(d) operator content keeps its bytes and gets the block appended", () => {
  for (const operator of [OPERATOR, OPERATOR.trimEnd(), `${OPERATOR}\n\n`, OPERATOR.replace(/\n/g, "\r\n")]) {
    const merged = mergeProjectRules(operator, TEMPLATE);
    assert.equal(merged.slice(0, operator.length), operator, "operator prefix changed");
    const rest = merged.slice(operator.length);
    const nl = operator.includes("\r\n") ? "\r\n" : "\n";
    assert.match(rest, new RegExp(`^(${nl})?${nl}${PROJECT_RULES_START}`), "one blank line before the block");
    assert.ok(rest.endsWith(`${PROJECT_RULES_END}${nl}`));
    assert.equal(blockBody(merged)?.replace(/\r\n/g, "\n"), TEMPLATE.trim());
  }
});

test("(e) a lone, duplicated or reversed marker is refused", () => {
  for (const broken of [
    `${OPERATOR}${PROJECT_RULES_START}\nbody\n`,
    `${OPERATOR}${PROJECT_RULES_END}\n`,
    `${PROJECT_RULES_END}\n${PROJECT_RULES_START}\n`,
    `${BLOCK}\n${BLOCK}\n`,
  ]) {
    assert.throws(() => mergeProjectRules(broken, TEMPLATE), /kherep-project-rules/);
    assert.throws(() => blockBody(broken), /kherep-project-rules/);
  }
});

test("a second merge changes nothing", () => {
  for (const start of [null, OPERATOR, OPERATOR.replace(/\n/g, "\r\n"), ""]) {
    const once = mergeProjectRules(start, TEMPLATE);
    assert.equal(mergeProjectRules(once, TEMPLATE), once);
  }
});

test("a template body with $ replacement patterns is inserted literally", () => {
  const dollars = "- use $& and $' and $1 literally\n";
  const merged = mergeProjectRules(`${PROJECT_RULES_START}\nold\n${PROJECT_RULES_END}\n`, dollars);
  assert.equal(blockBody(merged), dollars.trim());
});

test("blockBody reports a missing block as null", () => {
  assert.equal(blockBody(OPERATOR), null);
});

test("the Codex AGENTS block and the project block coexist in one file", () => {
  const codexStart = "<!-- kherep:start -->";
  const codexEnd = "<!-- kherep:end -->";
  for (const marker of [codexStart, codexEnd]) {
    assert.ok(!PROJECT_RULES_START.includes(marker) && !PROJECT_RULES_END.includes(marker));
  }
  let file = setMarkedBlock(OPERATOR, codexStart, codexEnd, "codex body");
  file = mergeProjectRules(file, TEMPLATE);
  const codexBlock = `${codexStart}\ncodex body\n${codexEnd}`;
  assert.ok(file.includes(codexBlock));
  file = setMarkedBlock(file, codexStart, codexEnd, "codex body v2");
  assert.equal(blockBody(file), TEMPLATE.trim(), "the Codex installer moved the project block");
  const again = mergeProjectRules(file, `${TEMPLATE}- rule three\n`);
  assert.ok(again.includes(`${codexStart}\ncodex body v2\n${codexEnd}`), "the project merge moved the Codex block");
});

// Director decision on OP-1425: the workspace block only points at the user-level
// rules, which the runtime loads anyway. An @-import would load them twice.
test("the project templates are references to the user-level rules", () => {
  const repo = path.join(import.meta.dirname, "..");
  const read = (...parts: string[]): string => fs.readFileSync(path.join(repo, ...parts), "utf8");
  for (const [name, target] of [["CLAUDE", "~/.claude/CLAUDE.md"], ["AGENTS", "~/.codex/AGENTS.md"]]) {
    const reference = read("claude", `${name}.project.md`);
    assert.ok(reference.includes(target), `${name}.project.md does not name ${target}`);
    assert.ok(reference.split("\n").length < 12, `${name}.project.md carries rule text again`);
    assert.doesNotMatch(reference, /^\s*@/m, `${name}.project.md imports a file`);
  }
  // The user-level sources carry the rules the old full templates carried.
  assert.match(read("claude", "CLAUDE.user.md"), /^## Authority and scope$/m);
  assert.match(read("codex", "AGENTS.user.md"), /^## Authority and scope$/m);
});

// Check available pre-public history and the public v0.1.0 whole-file release.
// v0.1.1 already installs marked blocks: its reference templates are excluded.
test("the known template set covers every whole-file template blob", (t) => {
  assert.ok(KNOWN_TEMPLATE_SHA256.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  if (!fs.existsSync(path.join(REPO, ".git"))) {
    t.skip("source export has no Git history; deterministic template regressions still run");
    return;
  }
  if (git(REPO, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    t.skip("shallow checkout; full template history is checked by Ubuntu unit CI");
    return;
  }
  assert.equal(git(REPO, ["show", `${LAST_WHOLE_FILE_COMMIT}:${TEMPLATE_PATHS[1]}`]), LEGACY_TEMPLATE);
  const blobs = wholeFileTemplateBlobs(REPO);
  assert.ok(blobs.length > 0, "the public whole-file release must be audited");
  for (const line of blobs) {
    assert.ok(isKnownTemplate(git(REPO, ["cat-file", "blob", line.split(" ")[0]])), `unknown blob ${line}`);
  }
});

test("history selection includes legacy releases and excludes archived post-migration trees", (t) => {
  const f = historyFixture(t);
  const boundary = f.commit(LEGACY_TEMPLATE, "2026-09-24T11:07:45Z");
  f.commit("post-migration reference\n", "2026-09-24T15:46:33Z");
  git(f.repo, ["-c", "tag.gpgsign=false", "tag", "-a", "v-next", "-m", "Synthetic annotated tag"]);
  const boundaryBlob = git(f.repo, ["rev-parse", `${boundary}:${TEMPLATE_PATHS[1]}`]).trim();
  const laterBlob = git(f.repo, ["rev-parse", `HEAD:${TEMPLATE_PATHS[1]}`]).trim();
  const tagWalk = git(f.repo, ["rev-list", "--objects", "--all", `--until=${LEGACY_CUTOFF}`, "--", ...TEMPLATE_PATHS]);
  assert.ok(!tagWalk.includes(laterBlob), "an annotated tag alone does not leak the later blob");
  git(f.repo, ["update-ref", "refs/archive/template-tree", git(f.repo, ["rev-parse", "HEAD^{tree}"]).trim()]);
  const oldWalk = git(f.repo, ["rev-list", "--objects", "--all", `--until=${LEGACY_CUTOFF}`, "--", ...TEMPLATE_PATHS]);
  assert.ok(oldWalk.includes(laterBlob), "the old walk includes a post-migration archive tree");
  const blobs = wholeFileTemplateBlobs(f.repo, boundary);
  assert.deepEqual(blobs, [`${boundaryBlob} ${TEMPLATE_PATHS[1]}`]);
  assert.throws(() => wholeFileTemplateBlobs(f.repo, "0".repeat(40)), /git rev-parse/);
  assert.throws(() => git(f.repo, ["cat-file", "blob", "0".repeat(40)]), /git cat-file/);
});

test("available pre-public templates remain audited and unknown ones fail recognition", (t) => {
  const f = historyFixture(t);
  const older = f.commit("pre-public whole-file template\n", "2026-09-23T12:00:00Z");
  const boundary = f.commit(LEGACY_TEMPLATE, "2026-09-24T11:07:45Z");
  const olderBlob = git(f.repo, ["rev-parse", `${older}:${TEMPLATE_PATHS[1]}`]).trim();
  const boundaryBlob = git(f.repo, ["rev-parse", `${boundary}:${TEMPLATE_PATHS[1]}`]).trim();
  const blobs = wholeFileTemplateBlobs(f.repo, boundary);
  assert.deepEqual(new Set(blobs.map((line) => line.split(" ")[0])), new Set([olderBlob, boundaryBlob]));
  assert.equal(isKnownTemplate(git(f.repo, ["cat-file", "blob", olderBlob])), false);
});
