// Issue #731 PR-B. The observation agents report what the promotion join reads:
// each page's finding position and evidence label. This pins the configured
// texts against the real parsers; it executes no agent and publishes nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderAgent } from "../codex/lib/component-render.mts";
import type { Capabilities } from "../codex/lib/contracts.mts";
import { agentSourcePath } from "../codex/lib/parity-projection.mts";
import { claudePages } from "../claude/hooks/lib/obs-promotion-policy.mts";
import { checkObsHandback } from "../modules/atl-jira-brokers/observation-result.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(REPO, relative), "utf8");
const CLAUDE_OBS = read("claude/agents/claude-obs.md");
const capabilities = JSON.parse(read("codex/parity/capabilities.json")) as Capabilities;
function codexProjection(): string {
  const options = capabilities.agents["claude-obs"];
  const toml = renderAgent(options.as || "claude-obs", fs.readFileSync(agentSourcePath(REPO, "claude-obs", options), "utf8"), options);
  const line = toml.split("\n").find((entry) => entry.startsWith("developer_instructions = "))!;
  return JSON.parse(line.slice("developer_instructions = ".length)) as string;
}
const ROUTING = ["claude/teams/kherep/ROUTING.md", "codex/ROUTING.md"].map((file) => {
  const text = read(file);
  return [file, text.slice(text.indexOf("## Session observations"), text.indexOf("## Linking"))] as const;
});
const CLAUDE_LINE = "`<id> finding=<n|-> evidence=<confirmed|assumed|refuted|superseded> <title>`";
const CODEX_LINE = "`OBS-EVIDENCE: <id>:<n|->:<label>[,...]`";

test("the Claude text defines the page line the join parses, and no longer the bare (id, title) line", () => {
  assert.ok(CLAUDE_OBS.includes(`one line per written page, exactly ${CLAUDE_LINE}`));
  assert.doesNotMatch(CLAUDE_OBS, /one line per written page \(id, title\)/);
  assert.match(CLAUDE_OBS, /1-based position of the brief finding the page files \(`-` when it files none\)/);
  const example = "OBS-RESULT: wrote 2 11,12\n11 finding=1 evidence=assumed Build passes\n12 finding=- evidence=confirmed Endpoint answers";
  assert.deepEqual([...claudePages(example)], [["11", { finding: 1, evidence: "assumed" }], ["12", { finding: null, evidence: "confirmed" }]]);
});

test("the Codex worker text defines the optional evidence line the receipt check accepts", () => {
  const text = codexProjection();
  assert.ok(text.includes(CODEX_LINE));
  assert.match(text, /one entry per created page id/);
  assert.match(text, /never part of the adapter receipt/);
  assert.match(text, /one strict line, with no Markdown fence or surrounding prose, except the\s+evidence line below/);
  const handback = checkObsHandback("OBS-RESULT: wrote 2 11,12\nOBS-EVIDENCE: 11:1:assumed,12:-:confirmed");
  assert.ok("evidence" in handback && Array.isArray(handback.evidence) && handback.evidence.length === 2);
});

test("both agent texts say what an assumed page for a measured finding triggers", () => {
  for (const text of [CLAUDE_OBS, codexProjection()]) {
    assert.match(text, /filed\s+`assumed` for a `measured:` finding makes the parent Stop hook ask the dispatching session once\s+to promote it with evidence or say why not/);
  }
});

test("both routing files describe the promotion trigger with the same paragraph", () => {
  const paragraph = (section: string) => section.slice(section.indexOf("Promotion trigger (#731 PR-B)"), section.indexOf("never a block.") + "never a block.".length);
  const [first, second] = ROUTING.map(([, section]) => paragraph(section));
  assert.ok(first.startsWith("Promotion trigger"), "the Claude routing has it");
  assert.equal(second, first);
  for (const pattern of [/<session_id>\.brief/, /<session_id>\.promote/, /continues the turn once/, /evidence verb/, /A marker alone never promotes a page/,
    /warning naming the page ids, never a block/]) assert.match(first, pattern);
});

test("the shared claim-scope contract no longer says PR-B is not implemented", () => {
  for (const file of ["claude/agents/claude-obs.md", "codex/agents/codex-obs.md", ...ROUTING.map(([name]) => name)]) {
    const text = read(file);
    assert.doesNotMatch(text, /PR-B correlation\/follow-up is not implemented/, file);
    assert.match(text, /PR-B joins each page's reported finding position and label/, file);
  }
});
