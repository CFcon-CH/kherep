// Which pages a stitch MAY link, and the paper trail that binds a write to that
// set (issue #736). Pure functions: no request, no file, no clock of its own.
//
// The broker searches, filters by structure and reports. It never decides a
// link: the agent that wrote the page judges each candidate and gives a reason,
// and the broker writes only those decisions, and only for candidates from a
// receipt it produced itself. Shared title words are a hint printed beside a
// candidate, never a reason to link it - on 2026-11-01 "account" and "state"
// linked a logon-task page to an owner-probe page and a Codex idle-state page.
import { contentTerms, rareTerms, type IndexedPage, type SpaceIndex } from "./confluence-related.mts";
import type { ProposalItem } from "./confluence-semantic.mts";
import { snippetLine } from "./confluence-topic-query.mts";

export interface Candidate {
  id: string;
  title: string;
  // The ancestor titles, root first: where the candidate sits in the space.
  area: string;
  // Rare content words shared with the source title. A hint, never a reason.
  terms: string[];
  snippet: string;
}

export const RECEIPT_KIND = "kherep-stitch-candidates";
export const RECEIPT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// A clock a little behind the one that wrote the receipt is not a forgery.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const REASON_MIN = 10;
export const REASON_MAX = 300;

// The Codex adapter searches before its page exists, so its receipt names the
// source by title and binds the session turn instead of a page id.
export const RELATED_RECEIPT_KIND = "related-candidates";

interface ReceiptBase {
  spaceKey: string;
  query: string;
  searchedAt: string;
  candidates: Candidate[];
}

export interface StitchReceipt extends ReceiptBase {
  kind: typeof RECEIPT_KIND;
  source: string;
}

export interface RelatedReceipt extends ReceiptBase {
  kind: typeof RELATED_RECEIPT_KIND;
  source: { title: string };
  sessionId: string;
  turnId: string;
}

export type Receipt = StitchReceipt | RelatedReceipt;

export interface Decision {
  id: string;
  reason: string;
}

export interface Problem {
  id: string;
  why: string;
}

export function areaOf(index: SpaceIndex, page: IndexedPage): string {
  const titles: string[] = [];
  const seen = new Set<string>([page.id]);
  for (let at = page.parentId; at && !seen.has(at); at = index.byId.get(at)?.parentId ?? null) {
    seen.add(at);
    const parent = index.byId.get(at);
    if (!parent) break;
    titles.unshift(parent.title);
  }
  return titles.join(" > ");
}

// Search order is the only ranking the search gives, so it is kept. A hit is
// matched by its page id when it carried one and by its exact title otherwise.
// Dropped: the page itself, pages outside the space, shelves and duplicates.
export function selectCandidates(
  index: SpaceIndex,
  source: { id?: string; title: string },
  items: readonly ProposalItem[],
  titles: readonly string[],
  limit: number,
): Candidate[] {
  const rare = rareTerms(index);
  const sourceTerms = contentTerms(source.title);
  const hits = [...items, ...titles.map((title) => ({ id: "", title, snippet: "" }))];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (out.length >= limit) break;
    const page = (hit.id && index.byId.get(hit.id)) || index.byTitle.get(String(hit.title).trim().toLowerCase());
    if (!page || page.id === source.id || seen.has(page.id) || index.parents.has(page.id)) continue;
    seen.add(page.id);
    const terms = [...contentTerms(page.title)].filter((term) => sourceTerms.has(term) && rare.has(term));
    out.push({ id: page.id, title: page.title, area: areaOf(index, page), terms, snippet: snippetLine(hit.snippet) });
  }
  return out;
}

// The tab-separated row a candidate prints as, after its label. Every field is
// one line by construction; a tab inside a title is the one thing to flatten.
export function candidateRow(candidate: Candidate): string {
  const field = (value: string) => value.replace(/[\t\r\n]+/g, " ");
  return [candidate.id, candidate.title, candidate.area, candidate.terms.join(","), candidate.snippet].map(field).join("\t");
}

const isText = (value: unknown): value is string => typeof value === "string";

function isCandidate(value: unknown): value is Candidate {
  const row = value as Candidate;
  return Boolean(row) && typeof row === "object" && isText(row.id) && /^\d+$/.test(row.id) && isText(row.title)
    && isText(row.area) && Array.isArray(row.terms) && row.terms.every(isText) && isText(row.snippet);
}

// A receipt that is not exactly one of the two shapes written here is no receipt.
export function parseReceipt(text: string): Receipt | null {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return null; }
  const receipt = json as Receipt;
  if (!receipt || typeof receipt !== "object" || !isText(receipt.spaceKey) || !isText(receipt.query)
    || !isText(receipt.searchedAt) || !Array.isArray(receipt.candidates) || !receipt.candidates.every(isCandidate)) return null;
  if (receipt.kind === RECEIPT_KIND && isText(receipt.source)) return receipt;
  if (receipt.kind === RELATED_RECEIPT_KIND && receipt.source && typeof receipt.source === "object"
    && isText(receipt.source.title) && isText(receipt.sessionId) && isText(receipt.turnId)) return receipt;
  return null;
}

// One approved target per line: `<id><TAB><reason>`. Blank lines are skipped,
// so an empty file is a valid "nothing was approved".
export function parseDecisions(text: string): Decision[] {
  return String(text).split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const tab = line.indexOf("\t");
    if (tab < 0) return { id: line.trim(), reason: "" };
    // A further tab would split the trace line the reason is printed into.
    return { id: line.slice(0, tab).trim(), reason: line.slice(tab + 1).replace(/\s+/g, " ").trim() };
  });
}

// The checks both receipt kinds share: space, age, and every decision.
function sharedProblems(receipt: Receipt, decisions: readonly Decision[], spaceKey: string, now: number, source: string): Problem[] {
  const problems: Problem[] = [];
  const whole = (why: string) => problems.push({ id: source, why });
  if (receipt.spaceKey.toUpperCase() !== spaceKey.toUpperCase()) whole("the receipt is for another space");
  const at = Date.parse(receipt.searchedAt);
  if (!Number.isFinite(at)) whole("the receipt has no readable search time");
  else if (now - at > RECEIPT_MAX_AGE_MS) whole("the receipt is older than 2 h");
  else if (at - now > CLOCK_SKEW_MS) whole("the receipt is dated in the future");

  const offered = new Set(receipt.candidates.map((candidate) => candidate.id));
  const decided = new Set<string>();
  for (const { id, reason } of decisions) {
    if (!/^\d+$/.test(id)) problems.push({ id: id || "-", why: "not a numeric page id" });
    else if (!offered.has(id)) problems.push({ id, why: "not a candidate in the receipt" });
    if (decided.has(id)) problems.push({ id, why: "decided more than once" });
    decided.add(id);
    // The reason lands in a trace line and in Confluence version history.
    if (!reason) problems.push({ id, why: "no reason given" });
    else if (/[\x00-\x1f\x7f-\x9f]/.test(reason)) problems.push({ id, why: "reason has non-printable characters" });
    else if (reason.length < REASON_MIN) problems.push({ id, why: `reason shorter than ${REASON_MIN} characters` });
    else if (reason.length > REASON_MAX) problems.push({ id, why: `reason longer than ${REASON_MAX} characters` });
  }
  return problems;
}

// Every problem, not the first: a refused write names all of them at once.
export function checkDecisions(
  receipt: Receipt | null,
  decisions: readonly Decision[],
  expected: { source: string; spaceKey: string; now: number },
): Problem[] {
  if (!receipt || receipt.kind !== RECEIPT_KIND) return [{ id: expected.source, why: "the candidates file is not a stitch receipt" }];
  const problems = receipt.source === expected.source ? [] : [{ id: expected.source, why: "the receipt is for another page" }];
  return [...problems, ...sharedProblems(receipt, decisions, expected.spaceKey, expected.now, expected.source)];
}

// The Codex adapter's form: the receipt must belong to this turn and title.
export function checkRelatedLinks(
  receipt: Receipt | null,
  decisions: readonly Decision[],
  expected: { title: string; spaceKey: string; sessionId: string; turnId: string; now: number },
): Problem[] {
  const whole = (why: string): Problem => ({ id: "-", why });
  if (!receipt || receipt.kind !== RELATED_RECEIPT_KIND) return [whole("the token names no related-candidates receipt")];
  const problems: Problem[] = [];
  if (receipt.sessionId !== expected.sessionId || receipt.turnId !== expected.turnId) problems.push(whole("the receipt is for another turn"));
  if (receipt.source.title !== expected.title) problems.push(whole("the receipt is for another title"));
  return [...problems, ...sharedProblems(receipt, decisions, expected.spaceKey, expected.now, "-")];
}
