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

export interface Receipt {
  kind: typeof RECEIPT_KIND;
  source: string;
  spaceKey: string;
  query: string;
  searchedAt: string;
  candidates: Candidate[];
}

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

// A receipt that is not exactly the shape this module writes is no receipt.
export function parseReceipt(text: string): Receipt | null {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return null; }
  const receipt = json as Receipt;
  if (!receipt || typeof receipt !== "object" || !isText(receipt.kind) || !isText(receipt.source)
    || !isText(receipt.spaceKey) || !isText(receipt.query) || !isText(receipt.searchedAt)
    || !Array.isArray(receipt.candidates) || !receipt.candidates.every(isCandidate)) return null;
  return receipt;
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

// Every problem, not the first: a refused write names all of them at once.
export function checkDecisions(
  receipt: Receipt | null,
  decisions: readonly Decision[],
  expected: { source: string; spaceKey: string; now: number },
): Problem[] {
  const problems: Problem[] = [];
  const whole = (why: string) => problems.push({ id: expected.source, why });
  if (!receipt) {
    whole("the candidates file is not a stitch receipt");
    return problems;
  }
  if (receipt.kind !== RECEIPT_KIND) whole("the candidates file is not a stitch receipt");
  if (receipt.spaceKey.toUpperCase() !== expected.spaceKey.toUpperCase()) whole("the receipt is for another space");
  if (receipt.source !== expected.source) whole("the receipt is for another page");
  const at = Date.parse(receipt.searchedAt);
  if (!Number.isFinite(at)) whole("the receipt has no readable search time");
  else if (expected.now - at > RECEIPT_MAX_AGE_MS) whole("the receipt is older than 2 h");
  else if (at - expected.now > CLOCK_SKEW_MS) whole("the receipt is dated in the future");

  const offered = new Set(receipt.candidates.map((candidate) => candidate.id));
  const decided = new Set<string>();
  for (const { id, reason } of decisions) {
    if (!/^\d+$/.test(id)) problems.push({ id: id || "-", why: "not a numeric page id" });
    else if (!offered.has(id)) problems.push({ id, why: "not a candidate in the receipt" });
    if (decided.has(id)) problems.push({ id, why: "decided more than once" });
    decided.add(id);
    if (!reason) problems.push({ id, why: "no reason given" });
    else if (reason.length < REASON_MIN) problems.push({ id, why: `reason shorter than ${REASON_MIN} characters` });
    else if (reason.length > REASON_MAX) problems.push({ id, why: `reason longer than ${REASON_MAX} characters` });
  }
  return problems;
}
