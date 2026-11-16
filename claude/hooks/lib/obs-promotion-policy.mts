// Issue #731 PR-B. A finding the dispatching session measured (`measured:`) can
// still be filed evidence-assumed, for example without an exact code binding.
// No hook saw the brief and the result together, so such a page stayed
// assumed unless someone noticed. This pure module is the join:
//
//   - the dispatch guards record the brief as `measured=<1-based positions>
//     findings=<count>` (integers only, never brief text);
//   - the result names each page with its finding position and evidence label:
//     a Claude page line `<id> finding=<n|-> evidence=<label> <title>`, or a
//     Codex `OBS-EVIDENCE: <id>:<n|->:<label>[,...]` line;
//   - a hit is a page labelled assumed whose finding position is measured.
//
// The parent Stop hook delivers the hits once with PROMOTION_REASON. A result
// whose labels cannot be read against a measured brief gets a warning naming
// the page ids, never a block. Pure: no I/O, and no text names anything but
// numeric page ids.
import { findings } from "./obs-brief-policy.mts";

export interface BriefRecord { measured: number[]; findings: number }
export interface PageEvidence { finding: number | null; evidence: string }
export interface JoinResult { hits: string[]; unreadable: string[] }

const POSITION = "[1-9]\\d{0,3}";
const BRIEF_LINE = new RegExp(`^measured=(-|${POSITION}(?:,${POSITION})*) findings=(0|${POSITION})\\n?$`);
const PAGE_LINE = new RegExp(`^(?:[-*][ \\t]+)?(\\d{1,30}) finding=(${POSITION}|-) evidence=(confirmed|assumed|refuted|superseded)[ \\t]+\\S`);
const WROTE_LINE = /^OBS-RESULT:[ \t]+wrote[ \t]+(.*)$/;
const PAGE_ID = /^\d{1,30}$/;

export const PROMOTION_PREFIX = "Kherep obs-promotion:";

export function briefRecord(brief: string): BriefRecord {
  const list = findings(brief);
  return { measured: list.flatMap((finding, index) => (finding.kind === "measured" ? [index + 1] : [])), findings: list.length };
}

export function formatBrief(record: BriefRecord): string {
  return `measured=${record.measured.length ? record.measured.join(",") : "-"} findings=${record.findings}\n`;
}

// null for any text that is not exactly one line formatBrief writes.
export function parseBrief(text: string): BriefRecord | null {
  const match = BRIEF_LINE.exec(text);
  if (!match) return null;
  const measured = match[1] === "-" ? [] : match[1]!.split(",").map(Number);
  const count = Number(match[2]);
  return measured.every((position) => position <= count) ? { measured, findings: count } : null;
}

// The page ids of a Claude `OBS-RESULT: wrote <n> <ids>` status line, the first non-empty line.
export function claudeIds(message: string): string[] {
  const first = message.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const match = WROTE_LINE.exec(first.trim());
  return match ? match[1]!.split(/[\s,]+/).filter(Boolean).slice(1).filter((id) => PAGE_ID.test(id)) : [];
}

// The Claude page lines after the status line; the first line of an id wins.
export function claudePages(message: string): Map<string, PageEvidence> {
  const pages = new Map<string, PageEvidence>();
  for (const line of message.split(/\r?\n/)) {
    const match = PAGE_LINE.exec(line.trim());
    if (match && !pages.has(match[1]!)) pages.set(match[1]!, { finding: match[2] === "-" ? null : Number(match[2]), evidence: match[3]! });
  }
  return pages;
}

// Nothing to join without a measured finding. A page without a readable label,
// or naming a finding the brief does not have, is unreadable, never a hit.
export function joinPromotion(brief: BriefRecord | null, ids: readonly string[], pages: ReadonlyMap<string, PageEvidence>): JoinResult {
  const result: JoinResult = { hits: [], unreadable: [] };
  if (!brief?.measured.length) return result;
  const measured = new Set(brief.measured);
  for (const id of ids) {
    const page = pages.get(id);
    if (!page || (page.finding !== null && page.finding > brief.findings)) result.unreadable.push(id);
    else if (page.evidence === "assumed" && page.finding !== null && measured.has(page.finding)) result.hits.push(id);
  }
  return result;
}

// Without a brief to join (no session id): the pages that could be a hit.
export function unjoinable(ids: readonly string[], pages: ReadonlyMap<string, PageEvidence>): string[] {
  return ids.filter((id) => {
    const page = pages.get(id);
    return page?.evidence === "assumed" && page.finding !== null;
  });
}

export function promotionReason(ids: readonly string[]): string {
  return `${PROMOTION_PREFIX} page(s) ${ids.join(", ")} were filed evidence-assumed for finding(s) the brief marked measured:. `
    + "In this turn, for each page run the Confluence broker evidence verb (--mode prepare, then decide, then verify) with this turn's measurement, "
    + "or state in your final message why it cannot be promoted (for example no exact code binding). A marker alone never promotes a page.";
}

export function unreadableWarning(ids: readonly string[]): string {
  return `${PROMOTION_PREFIX} the evidence labels of page(s) ${ids.join(", ")} could not be read against the brief's measured: findings; `
    + "check by hand whether a measured finding was filed evidence-assumed.";
}

// Why a result could not be joined; the cause is one of these fixed texts.
export const NO_SESSION = "no session id";
export const NO_BRIEF = "no dispatch brief recorded for this session";

export function unjoinedWarning(ids: readonly string[], cause: typeof NO_SESSION | typeof NO_BRIEF): string {
  return `${PROMOTION_PREFIX} page(s) ${ids.join(", ")} were filed evidence-assumed but could not be joined to the dispatch brief (${cause}); `
    + "check by hand whether their findings were marked measured:.";
}
