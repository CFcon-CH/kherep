// Stage 1 of the model backend (issue #1020): the candidate pool, built on the
// host. Every leaf title of the already loaded space inventory is scored
// lexically in memory (BM25), and one CQL full-text request adds body hits with
// their excerpts. The model later ranks this pool; it can drop a candidate but
// never add one, because only inventory pages enter it.
import { ConfluenceRequestError, SCOPES, v1 } from "./confluence-contract.mts";
import { strictRows } from "./confluence-pagination.mts";
import { contentTerms } from "./confluence-related.mts";
import type { SemanticPool } from "./confluence-semantic.mts";
import type { IndexedPage, SpaceIndex } from "./confluence-space-index.mts";

export const TITLE_POOL = 40;
export const BODY_POOL = 25;
export const POOL_CAP = 65;
export const EXCERPT_CHARS = 240;
export const CQL_WORDS = 12;

export interface PoolEntry {
  id: string;
  title: string;
  excerpt: string;
}

// The content words of a text (contentTerms) plus bare numbers, split once more
// into [a-z0-9]+ so that no Lucene character can reach the CQL.
export function poolTerms(text: string): string[] {
  const out = new Set<string>();
  for (const word of [...contentTerms(text), ...(String(text).match(/\b\d+\b/g) ?? [])]) {
    for (const part of word.toLowerCase().split(/[^a-z0-9]+/)) if (part) out.add(part);
  }
  return [...out];
}

const leaves = (index: SpaceIndex): IndexedPage[] => [...index.byId.values()].filter((page) => !index.parents.has(page.id));

// BM25 (k1 1.2, b 0.75) over the leaf titles. Shelves are left out: every
// caller drops them afterwards, so they would only take pool places. Ties keep
// a deterministic order: higher score first, then the lower page id.
export function titleCandidates(index: SpaceIndex, terms: readonly string[], limit = TITLE_POOL): PoolEntry[] {
  const docs = leaves(index).map((page) => ({ page, terms: new Set(poolTerms(page.title)) }));
  if (!docs.length || !terms.length) return [];
  const average = docs.reduce((sum, doc) => sum + doc.terms.size, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.terms) df.set(term, (df.get(term) ?? 0) + 1);
  const queryTerms = new Set(terms);
  const scored: { page: IndexedPage; score: number }[] = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of queryTerms) {
      if (!doc.terms.has(term)) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * 2.2) / (1 + 1.2 * (0.25 + (0.75 * doc.terms.size) / average));
    }
    if (score > 0) scored.push({ page: doc.page, score });
  }
  scored.sort((a, b) => b.score - a.score || a.page.id.localeCompare(b.page.id, "en", { numeric: true }));
  return scored.slice(0, limit).map(({ page }) => ({ id: page.id, title: page.title, excerpt: "" }));
}

export function bodyCql(spaceKey: string, terms: readonly string[]): string | null {
  const words = terms.slice(0, CQL_WORDS);
  if (!words.length) return null;
  return `space=${JSON.stringify(spaceKey)} and type=page and (${words.map((word) => `text ~ "${word}"`).join(" or ")})`;
}

const excerptOf = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS) : "");

// One request, GET /wiki/rest/api/search with excerpt=indexed (probe P10). A
// failed request fails the whole call: a knowingly incomplete pool would look
// complete to the model and to the caller.
export async function bodyCandidates(pool: SemanticPool, terms: readonly string[]): Promise<PoolEntry[] | { error: string }> {
  const cql = bodyCql(pool.spaceKey, terms);
  if (cql === null) return [];
  let json: unknown;
  try {
    ({ json } = await pool.session.request({
      method: "GET",
      path: v1(`/search?cql=${encodeURIComponent(cql)}&limit=${BODY_POOL}&excerpt=indexed`),
      scope: SCOPES.get,
    }));
  } catch (error) {
    if (error instanceof ConfluenceRequestError) return { error: `the candidate text search failed with HTTP ${error.status}` };
    return { error: `the candidate text search failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` };
  }
  let rows: Record<string, unknown>[];
  try {
    rows = strictRows(json);
  } catch {
    return { error: "the candidate text search returned an unreadable result" };
  }
  return rows.map((row) => {
    const content = (row.content ?? {}) as { id?: unknown; title?: unknown };
    return { id: typeof content.id === "string" ? content.id : "", title: String(content.title ?? row.title ?? ""), excerpt: excerptOf(row.excerpt) };
  });
}

// Title candidates first, then body hits not already present; a body hit on a
// title candidate lends it its excerpt. Only leaf pages of the inventory enter.
export async function buildPool(query: string, pool: SemanticPool): Promise<{ entries: PoolEntry[] } | { error: string }> {
  const terms = poolTerms(query);
  if (!terms.length) return { error: "the query has no searchable word" };
  const body = await bodyCandidates(pool, terms);
  if ("error" in body) return body;
  const entries = titleCandidates(pool.pages, terms);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const hit of body) {
    const page = pool.pages.byId.get(hit.id);
    if (!page || pool.pages.parents.has(page.id)) continue;
    const known = byId.get(page.id);
    if (known) {
      known.excerpt ||= hit.excerpt;
      continue;
    }
    const entry = { id: page.id, title: page.title, excerpt: hit.excerpt };
    byId.set(page.id, entry);
    entries.push(entry);
  }
  return { entries: entries.slice(0, POOL_CAP) };
}
