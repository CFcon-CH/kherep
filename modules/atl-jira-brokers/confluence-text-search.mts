// The exact-term half of the neighbour search. It hits rarely and precisely,
// which is the opposite failure mode to the semantic half - that is the entire
// reason to keep it.
//
// The value of `text ~ "..."` is parsed twice: once as a CQL string, then by
// Lucene, whose syntax includes ( ) ~ " \ : * ? [ ] { } ^ ! + - /. The raw
// title used to go through unescaped, and titles carrying those characters drew
// HTTP 403 and 500 (issue #651). The only escape Atlassian documents inside a
// CQL string is \", so this module does not escape: it keeps only lowercase
// ASCII letters and digits, which cannot be syntax. Lowercase also matters for
// the words AND, OR, NOT: Lucene operators must be ALL CAPS, so a lowercase one
// is a plain term.
//
// A result row without a readable title is counted, never dropped: a dropped
// row made a response with hits look like one without any (issue #656).
import { ConfluenceRequestError, SCOPES, v1, type ConfluenceSession } from "./confluence-contract.mts";
import { strictRows } from "./confluence-pagination.mts";
import { contentTerms } from "./confluence-related.mts";

// The content words of a title, split once more so that contentTerms' inner
// . + - (node.js, vite-plugin) cannot reach Lucene. Order of first appearance,
// no duplicates: the content words of the title, the same words the candidate
// terms hint is computed from (confluence-candidates.mts).
export function textTerms(title: string): string[] {
  const out = new Set<string>();
  for (const term of contentTerms(title)) {
    for (const part of term.split(/[^a-z0-9]+/)) if (part) out.add(part);
  }
  return [...out];
}

// Every word required, in no particular order - Atlassian's documented reading
// of several words inside one quoted value. Null when there is nothing to search.
export function textCql(spaceKey: string, terms: string[]): string | null {
  if (!terms.length) return null;
  return `space=${JSON.stringify(spaceKey)} and type=page and text ~ "${terms.join(" ")}"`;
}

// Why the exact half is incomplete. "http": the request was refused or failed
// (status and Atlassian's words). "rows": the request succeeded, but
// `unreadable` of `rows` result rows carried no readable title in either of the
// two documented places (content.title, title). A rows failure has no status
// and invents none. titles is [] for "http"; for "rows" it holds every title
// that WAS readable, in response order.
export type TextFailure =
  | { kind: "http"; status: number; detail: string }
  | { kind: "rows"; unreadable: number; rows: number };

export interface TextHits {
  titles: string[];
  // The CQL that was sent; null when the title had no searchable word and no request was made.
  cql: string | null;
  // Present when this half is incomplete. Callers gate on `failure` alone: that
  // is the one channel, so no caller can honour one kind and miss the other.
  failure?: TextFailure;
}

export async function textSearch(
  session: ConfluenceSession,
  spaceKey: string,
  title: string,
  limit = 10,
): Promise<TextHits> {
  const cql = textCql(spaceKey, textTerms(title));
  if (cql === null) return { titles: [], cql };
  const path = v1(`/search?cql=${encodeURIComponent(cql)}&limit=${limit}`);
  let json: unknown;
  try {
    ({ json } = await session.request({ method: "GET", path, scope: SCOPES.get }));
  } catch (error) {
    // A refused request is one unsearched half, not a reason to end the run.
    // Anything else (network, a broker bug) still aborts.
    if (!(error instanceof ConfluenceRequestError)) throw error;
    return { titles: [], cql, failure: { kind: "http", status: error.status, detail: error.detail } };
  }
  const rows = strictRows(json); // structural failures still throw
  const titles: string[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const title = rowTitle(row);
    if (title === null) unreadable += 1; else titles.push(title);
  }
  return unreadable ? { titles, cql, failure: { kind: "rows", unreadable, rows: rows.length } } : { titles, cql };
}

// A title is readable when it is a string with non-whitespace content. Judged
// on trim(), returned as-is: selectCandidates trims for lookup, nothing else needs
// normalising.
function readable(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// One row counts once, after both documented places were tried.
function rowTitle(row: Record<string, unknown>): string | null {
  return readable((row.content as { title?: unknown } | undefined)?.title) ?? readable(row.title);
}

// One line for the operator. It names the status, never a cause the broker did
// not measure: 400 is the only status whose meaning the endpoint documents. A
// rows failure names its count instead and never prints an HTTP status.
export function textFailureLine(hits: TextHits): string {
  const f = hits.failure;
  if (f?.kind === "rows") {
    return `exact-term search: ${f.unreadable} of ${f.rows} result row(s) had no readable title. Hits from this half are incomplete and UNKNOWN. cql: ${hits.cql}`;
  }
  const { status, detail } = f ?? { status: 0, detail: "" };
  const hint = status === 400 ? " (the CQL query cannot be parsed)" : "";
  const said = detail ? ` - ${detail}` : "";
  return `exact-term search: HTTP ${status}${hint}${said}. Hits from this half are UNKNOWN. cql: ${hits.cql}`;
}
