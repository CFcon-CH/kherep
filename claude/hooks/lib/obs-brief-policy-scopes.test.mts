// #731: these tests check declarations, never claim native/model classification.
import assert from "node:assert/strict";
import test from "node:test";
import { observationBriefIssue, observationBriefNotice } from "./obs-brief-policy.mts";
const SHA = "a".repeat(40);

test("explicit live/doc/tracker scope does not request an irrelevant checkout binding", () => {
  for (const brief of [
    "measured: live `public-image-audit --fixture public-site` -> matched=27 mismatch=0 comparison=code-commit",
    "measured: doc `read-public-doc --fixture policy` -> document states tests passed",
    "measured: tracker `read-public-issue --fixture issue` -> state=open",
  ]) {
    assert.equal(observationBriefIssue(brief), null);
    assert.equal(observationBriefNotice(brief), null);
  }
});

test("explicit scope is exact and cannot absorb code bindings or ambiguous prefix words", () => {
  for (const prefix of ["Live", "live code", `live repo@${SHA}`, "doc tracker", "refused extra"]) {
    assert.ok(observationBriefNotice(`measured: ${prefix} \`check-ref: public-policy#safe-check\` -> ok`), prefix);
  }
  assert.match(observationBriefNotice("measured: code `check` -> ok") ?? "", /files each as assumed/);
  assert.match(observationBriefNotice(`measured: code repo@${SHA}-dirty -- src/check.mts \`check\` -> ok`) ?? "", /dirty tree/);
});

test("safe refusal reference is an evidence reference, not a command or result", () => {
  const brief = "measured: refused `check-ref: public-policy#safe-host-check` -> guard=secret-output-guard decision=deny event=safe-event-1";
  assert.equal(observationBriefIssue(brief), null);
  assert.equal(observationBriefNotice(brief), null);
});

test("refusal references reject executable expansion, paths and ambiguous references without echo", () => {
  for (const reference of ["check", "check-ref: ../public", "check-ref: a#b extra", "check-ref: $(unsafe)", "check-ref: https://example.invalid/x", "check-ref: /absolute", "check-ref: public-policy#safe-check\n"]) {
    const brief = `measured: refused \`${reference}\` -> guard=public-policy decision=deny event=safe-event-1`;
    const reason = observationBriefIssue(brief);
    assert.match(reason ?? "", /safe check reference/);
    assert.equal(observationBriefNotice(brief), null);
    assert.equal(reason, observationBriefIssue("measured: refused `not-a-reference` -> withheld"));
  }
});

test("refusal without a deciding event stays notice-only and never attests execution", () => {
  for (const excerpt of ["denied", "guard=public-policy decision=allow event=safe-event-1", "guard=public-policy decision=deny", "guard=public-policy decision=deny event=../unsafe"]) {
    const brief = `measured: refused \`check-ref: public-policy#safe-host-check\` -> ${excerpt}`;
    assert.equal(observationBriefIssue(brief), null);
    assert.match(observationBriefNotice(brief) ?? "", /refusal.*assumed/i);
  }
});

test("installed-copy prose or equal hashes cannot replace the existing full clean code binding", () => {
  const command = "`installed-copy-check --fixture public-copy`";
  const excerpt = `installed-sha256=${"b".repeat(64)} source-sha256=${"b".repeat(64)} source-clean=true malformed=1`;
  for (const binding of ["", "repo@HEAD -- src/check.mts", `repo@${SHA}-dirty -- src/check.mts`]) {
    const brief = `measured: code ${binding} ${command} -> ${excerpt}`;
    assert.equal(observationBriefIssue(brief), null);
    assert.match(observationBriefNotice(brief) ?? "", /files each as assumed/);
  }
  assert.ok(observationBriefNotice(`measured: installed ${command} -> ${excerpt}`), "installed is not a non-code exemption");
  // A silent declaration is not confirmation of hashes or actual execution.
  assert.equal(observationBriefNotice(`measured: code repo@${SHA} -- src/check.mts ${command} -> ${excerpt}`), null);
});
