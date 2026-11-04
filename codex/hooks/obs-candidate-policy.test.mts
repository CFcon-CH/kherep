import assert from "node:assert/strict";
import test from "node:test";

import { checkObsCandidate } from "./obs-candidate-policy.mts";
import { revisionLines } from "../../modules/atl-jira-brokers/confluence-claim-text.mts";

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Synthetic finding",
    bodyStorage: "<p>Synthetic body.</p>",
    evidence: "assumed",
    labels: ["type-observation", "evidence-assumed", "status-author-model"],
    placement: { project: "Synthetic project", app: "Synthetic app" },
    ...overrides,
  };
}

const doc = (...observations: unknown[]): string => JSON.stringify({ observations });
const problem = (message: string): string => {
  const check = checkObsCandidate(message);
  assert.ok("problem" in check, `expected a problem for ${message}`);
  return check.problem;
};

test("an empty observations array is valid", () => {
  assert.deepEqual(checkObsCandidate('{ "observations": [] }'), { count: 0 });
  assert.deepEqual(checkObsCandidate(`\n${doc()}\n`), { count: 0 });
});

test("well-formed candidates are valid for every evidence value and label order", () => {
  const items = ["confirmed", "assumed", "refuted", "superseded"].map((evidence) =>
    candidate({ evidence, labels: ["status-author-model", `evidence-${evidence}`, "type-observation"] }));
  assert.deepEqual(checkObsCandidate(doc(...items)), { count: 4 });
});

test("anything but one strict JSON document is malformed", () => {
  for (const message of [
    `\`\`\`json\n${doc()}\n\`\`\``,
    `Here is the candidate:\n${doc()}`,
    `${doc()}\nDone.`,
    "OBS-RESULT: empty nothing new",
    "",
  ]) assert.match(problem(message), /no strict JSON document/, message);
});

test("the envelope has exactly one observations array", () => {
  for (const message of ["[]", "null", '"observations"', '{"observations":{}}', "{}",
    JSON.stringify({ observations: [], note: "extra" })]) {
    assert.match(problem(message), /only key is not an observations array/, message);
  }
});

test("each candidate has exactly the five fields", () => {
  assert.match(problem(doc("text")), /no object/);
  assert.match(problem(doc(candidate({ related: "x" }))), /exactly title, bodyStorage/);
  const { placement: _placement, ...missing } = candidate();
  assert.match(problem(doc(missing)), /exactly title, bodyStorage/);
  assert.match(problem(doc(candidate({ title: " " }))), /empty title or bodyStorage/);
  assert.match(problem(doc(candidate({ bodyStorage: 7 }))), /empty title or bodyStorage/);
});

test("evidence and labels follow the four values and the three base labels", () => {
  assert.match(problem(doc(candidate({ evidence: "verified" }))), /unknown evidence value/);
  for (const labels of [
    ["type-observation", "evidence-confirmed", "status-author-model"],
    ["type-observation", "evidence-assumed"],
    ["type-observation", "evidence-assumed", "status-author-model", "session-1"],
    ["type-observation", "evidence-assumed", "evidence-assumed"],
    "type-observation",
  ]) assert.match(problem(doc(candidate({ labels }))), /three base labels/, JSON.stringify(labels));
});

test("placement is exactly a non-empty project and app", () => {
  for (const placement of [{ project: "p" }, { project: "p", app: "" }, { project: "p", app: "a", node: "n" }, "p/a", null]) {
    assert.match(problem(doc(candidate({ placement }))), /placement/, JSON.stringify(placement));
  }
});

// Issue #505 (D3). A confirmed candidate that names a revision names it as
// <repo>@<full commit sha>; assumed bodies and absent lines are not checked.
const NOT_BOUND = "a confirmed candidate names a revision that is not <repo>@<full commit sha> with an optional repo-relative path list";

test("a confirmed candidate's Revision lines bind a full commit SHA", () => {
  const sha = "2733b35e2c102ac54295568509c68b18b6d92cab";
  const confirmed = (body: string) => doc(candidate({
    evidence: "confirmed", labels: ["type-observation", "evidence-confirmed", "status-author-model"], bodyStorage: body,
  }));
  const assumed = (body: string) => doc(candidate({ bodyStorage: body }));
  for (const body of [`<p>Revision: kherep@${sha}</p>`, `<p>Revision: CFcon-CH/kherep@${sha}</p><p>Revision: other@${sha}</p>`,
    "<p>Synthetic body without a revision line.</p>"]) {
    assert.deepEqual(checkObsCandidate(confirmed(body)), { count: 1 }, body);
  }
  for (const value of ["kherep@HEAD", "kherep@2733b35", `kherep@${sha}-dirty`, `kherep@${sha} (no exact binding: dirty tree)`,
    "none (no exact binding: no repository)", `kherep@${sha.toUpperCase()}`, `https://example.com/kherep@${sha}`,
    `D:/work/kherep@${sha}`, `/home/x/kherep@${sha}`, `@${sha}`]) {
    const body = `<p>Revision: kherep@${sha}</p><p>Revision: ${value}</p>`;
    assert.equal(problem(confirmed(body)), NOT_BOUND, value);
    assert.doesNotMatch(problem(confirmed(body)), /example|kherep@|[0-9a-f]{7,}/, value);
    assert.deepEqual(checkObsCandidate(assumed(body)), { count: 1 }, value);
  }
  assert.deepEqual(checkObsCandidate(confirmed("<p>The printed label is Revision: draft.</p>")), { count: 1 }, "prose is no Revision line");
  assert.equal(problem(confirmed(`<p>Revision: alpha@${sha}<em>-dirty</em></p>`)),
    NOT_BOUND, "markup cannot hide a suffix");
  assert.deepEqual(checkObsCandidate(confirmed(`<p>Revision:\nalpha@${sha}</p>`)), { count: 1 }, "a line break after Revision:");
  assert.match(problem(doc(candidate({ evidence: "confirmed", bodyStorage: `<p>Revision: kherep@${sha}</p>`, extra: 1 }))),
    /exactly title, bodyStorage/, "a sixth key fails as before");
});

test("a problem never quotes the message", () => {
  const secret = "Example Corp host.example.com";
  for (const message of [secret, doc(candidate({ evidence: secret })), doc(candidate({ placement: { project: secret } }))]) {
    assert.ok(!problem(message).includes("Example Corp"));
  }
});

// Issue #693 T10: a confirmed candidate may scope its Revision line to repo-relative paths, by the page grammar.
test("a confirmed candidate's Revision line may carry a path list, validated like the page", () => {
  const sha = "2733b35e2c102ac54295568509c68b18b6d92cab";
  const as = (evidence: string, value: string) => doc(candidate({ evidence, labels: ["type-observation", `evidence-${evidence}`, "status-author-model"],
    bodyStorage: `<p>Revision: ${value}</p>` }));
  const lines = [`kherep@${sha} -- modules/a.mts docs/b.md`, `kherep@${sha}  --\tsrc/a.mts`, `kherep@${sha} -- src/*.mts`, `kherep@${sha} -- ../x.mts`,
    `kherep@${sha} -- a.mts a.mts`, `kherep@${sha} --`, `kherep@${sha} -- a -- b`, `kherep@${sha} -- /abs.mts`, `kherep@${sha}`, `kherep@HEAD -- a.mts`,
    `kherep@${sha} -- ${Array.from({ length: 17 }, (_, i) => `f${i}`).join(" ")}`];
  for (const value of lines) {
    const page = revisionLines(`<p>Revision: ${value}</p>`);
    const pageOk = page.bound.length === 1 && page.malformed.length === 0;
    assert.equal("count" in checkObsCandidate(as("confirmed", value)), pageOk, `page and candidate agree: ${value}`);
    assert.deepEqual(checkObsCandidate(as("assumed", value)), { count: 1 }, `assumed stays unchecked: ${value}`);
  }
  assert.deepEqual(checkObsCandidate(as("confirmed", lines[0])), { count: 1 });
  assert.equal(problem(as("confirmed", lines[2])), NOT_BOUND);
  assert.doesNotMatch(problem(as("confirmed", lines[2])), /src|kherep|[0-9a-f]{7,}/);
});
