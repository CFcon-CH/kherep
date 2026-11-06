// Finds the pages a new page belongs next to, so that writing one does not
// silently produce another page nobody links to.
//
// Two signals, because neither is sufficient alone and they fail differently.
// Both were measured on 2026-09-22 against five pages in the live space that
// had no incoming link:
//
//   - CQL full text does not rank. The AND form returned nothing in three of
//     the five cases; the OR form returned the same unrelated pages for
//     completely different sources. On its own it is a keyword filter wearing
//     the word "search", not a neighbourhood signal.
//   - The semantic search does rank. It paired the two Pinokio pages with each
//     other and found four true Jira neighbours for a Jira page. But it has no
//     space filter, it returns no score, and it offers structure nodes and the
//     same handful of strangers over and over.
//
// So the semantic side proposes and the structure filters: a candidate has to
// be a page in THIS space and a leaf rather than a shelf. Shared title words
// used to decide as well (issue #86), and still let wrong-topic pages through
// on a word like "account" or "state" (issue #736). They are now only a hint
// printed beside a candidate; whoever wrote the page judges each one on topic
// (confluence-candidates.mts).
import { ConfluenceError, SCOPES, v2, type ConfluenceSession } from "./confluence-contract.mts";

import { strictRows, nextPath, ReadFailure, readFailure } from './confluence-pagination.mts';

export interface IndexedPage {
  id: string;
  title: string;
  parentId: string | null;
}

export interface SpaceIndex {
  byId: Map<string, IndexedPage>;
  // Lowercased title. Titles are unique per space here, by construction: the
  // carry-over resolved collisions by qualifying with the parent segment.
  byTitle: Map<string, IndexedPage>;
  // Every page that is somebody's parent. In this deliberately flat hierarchy a
  // page with children is a shelf, not a book - so this set IS the structure,
  // derived from the live space instead of copied into a constant that rots.
  parents: Set<string>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class InventoryError extends ConfluenceError {
  index: SpaceIndex;
  failure: {reason: string; httpStatus?: number};
  constructor(index: SpaceIndex, error: unknown) {
    super('Space inventory incomplete: malformed, stalled or failed read.');
    this.index = index;
    this.failure = readFailure(error);
  }
}

// Preserve successfully read rows on failure, but never return a partial index as complete.
export async function spaceIndex(session: ConfluenceSession, spaceId: string): Promise<SpaceIndex> {
  if (!/^\d+$/.test(spaceId)) throw new ConfluenceError('Space id must be numeric.');
  const index: SpaceIndex = { byId: new Map(), byTitle: new Map(), parents: new Set() };
  const endpoint = v2(`/spaces/${spaceId}/pages`);
  let path: string | null = `${endpoint}?limit=250&status=current`;
  const visited = new Set<string>();
  try {
    while (path) {
      if (visited.has(path)) throw new ReadFailure('pagination-loop');
      visited.add(path);
      const { json } = await session.request({ method: 'GET', path, scope: SCOPES.get });
      const before = index.byId.size;
      for (const row of strictRows(json)) {
        if (typeof row.id !== 'string' || !/^\d+$/.test(row.id) || typeof row.title !== 'string'
          || (row.spaceId !== undefined && row.spaceId !== spaceId)
          || (row.parentId !== undefined && row.parentId !== null && typeof row.parentId !== 'string')) {
          throw new ReadFailure('malformed-inventory-page');
        }
        const page: IndexedPage = { id: row.id, title: row.title, parentId: text(row.parentId) || null };
        index.byId.set(page.id, page);
        index.byTitle.set(page.title.toLowerCase(), page);
        if (page.parentId) index.parents.add(page.parentId);
      }
      path = nextPath(json, endpoint);
      if (path && index.byId.size === before) throw new ReadFailure('stalled-pagination');
    }
    return index;
  } catch (error) {
    throw new InventoryError(index, error);
  }
}

// English only: everything in this space is written in English by convention.
const STOP = new Set(
  ("the a an and or of for in on to with without from by is are was were be being been not no this that these" +
    " those it its as at into over under via when then than which who whom whose how why what does do did done" +
    " has have had can could should would will shall may might must about after before during between each" +
    " other more most only just also does per use used using")
    .split(" "),
);

// Words that are not grammar but still name no topic: they describe what was
// done to something, not what it is. Live dry runs on 2026-09-27 linked pages
// on "test", "instead", "uses" and "missing" alone, so they are listed here
// rather than left to the frequency rule, which lets a word through while it
// is still rare.
const GENERIC = new Set(
  ("instead test tests testing fixed fixes update updates change changes added adding removed" +
    " issue issues check checks still need needs make work works like first uses missing")
    .split(" "),
);

// A token counts when it carries meaning on its own: a word of four or more
// letters, or an acronym. The acronyms are the point - AQL, JQL, CQL, JSM, OSGi
// are the most distinctive tokens in this corpus and a plain length rule throws
// exactly them away.
export function contentTerms(source: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(source).split(/[^A-Za-z0-9.+-]+/)) {
    const token = raw.replace(/^[.+-]+|(?<![.+-])[.+-]+$/g, "");
    if (!token) continue;
    const acronym = /^[A-Z][A-Z0-9]{1,}$/.test(token);
    const lower = token.toLowerCase();
    const word = token.length >= 4 && !STOP.has(lower) && !GENERIC.has(lower);
    if (acronym || word) out.add(token.toLowerCase());
  }
  return out;
}

// Only a rare word is worth a hint: one that at most this share of the space's
// titles carry. A shared rare word suggests two pages are about the same thing;
// a frequent one says only that they belong to the same product. Measured on the
// live space (620 titles) on 2026-09-27: the product name sat in 47 titles
// (7.6%) and a platform name in 83 (13%), both under the earlier one-in-five
// cutoff, while the specific words (tool and platform names) sat in 2 to 10.
// Three percent (18 titles there) keeps those and drops the labels.
const RARE_TERM_SHARE = 0.03;
// Up to this many titles a word is always rare, whatever its share: in a space
// of a handful of pages every word is a large share, and two pages sharing a
// word is exactly the pairing this filter exists to find.
const RARE_TERM_MIN_TITLES = 3;

// The words that count as a hint. Counted over the titles the index already
// holds, so the cutoff costs no request and follows the space as it grows.
export function rareTerms(index: SpaceIndex): Set<string> {
  const counts = new Map<string, number>();
  for (const page of index.byId.values()) {
    for (const term of contentTerms(page.title)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const limit = Math.max(RARE_TERM_MIN_TITLES, index.byId.size * RARE_TERM_SHARE);
  const rare = new Set<string>();
  for (const [term, n] of counts) {
    if (n <= limit) rare.add(term);
  }
  return rare;
}

// The storage body, which getPage deliberately does not carry: a verb that
// prints a page has no business pulling a whole document down with it. Only the
// neighbourhood needs the body, and only to read the links out of it.
export async function pageStorage(session: ConfluenceSession, id: string): Promise<string> {
  const { json } = await session.request({
    method: "GET",
    path: v2(`/pages/${encodeURIComponent(id)}?body-format=storage`),
    scope: SCOPES.get,
  });
  const value = (json as { body?: { storage?: { value?: unknown } } })?.body?.storage?.value;
  return text(value);
}

export interface DanglingAnchor {
  id: string;
  reason: "no such page" | "page is in another space";
}

// Every page link in a body, checked against the site before the body is
// written. One lookup per anchor and none at all for a body without anchors,
// which is why this can sit in front of every write instead of only some.
//
// The rule it enforces cannot be enforced by asking: on 2026-09-22 the
// observation agent named nine related pages in its bodies and seven of them did
// not exist. It had read the instruction not to twice. A reference that points
// nowhere is worse than no reference, because it reads like a trail.
export async function danglingAnchors(
  session: ConfluenceSession,
  storage: string,
  spaceId: string,
): Promise<DanglingAnchor[]> {
  const out: DanglingAnchor[] = [];
  for (const id of outgoingIds(storage)) {
    let json: unknown;
    try {
      ({ json } = await session.request({
        method: "GET",
        path: v2(`/pages/${encodeURIComponent(id)}`),
        scope: SCOPES.get,
      }));
    } catch {
      // A page that cannot be read is not a page this body may point at. The
      // guard fails closed: an unreadable target and an absent one are the same
      // answer to the only question being asked.
      out.push({ id, reason: "no such page" });
      continue;
    }
    const where = text((json as { spaceId?: unknown })?.spaceId);
    if (where !== spaceId) out.push({ id, reason: "page is in another space" });
  }
  return out;
}

// Refuses the write rather than reporting afterwards. A body with an invented
// link must never reach the space: once it is there, nothing distinguishes it
// from a real trail except following it.
export async function requireResolvableAnchors(
  session: ConfluenceSession,
  storage: string,
  spaceId: string,
): Promise<void> {
  const bad = await danglingAnchors(session, storage, spaceId);
  if (!bad.length) return;
  const detail = bad.map((a) => `${a.id} (${a.reason})`).join(", ");
  throw new ConfluenceError(
    `The body links to ${bad.length} page(s) that this space does not hold: ${detail}. `
    + "Link only pages you have seen a search return, or write no link and say that none matched.",
  );
}

// The neighbourhood of a page: what it points at, what sits beside it. This is
// what a later context delivery traverses - knowing a page's neighbours is the
// difference between a search result and context.
export interface Neighbourhood {
  page: IndexedPage;
  parent: IndexedPage | null;
  siblings: IndexedPage[];
  outgoing: IndexedPage[];
}

// Confluence serves the same page under two href shapes and both occur in this
// space: the space-relative one that this code writes, and the legacy
// viewpage.action form that the editor and some agents produce. A parser that
// knows only one of them under-reports links silently - it reported four of
// nine observation pages as unlinked on 2026-09-22 when all nine carried
// anchors, and the write guard built on it would have waved those anchors
// through unchecked.
const PAGE_HREFS = [
  /\/wiki\/spaces\/[^/"'\s]+\/pages\/(\d+)/g,
  /\/wiki\/pages\/viewpage\.action\?pageId=(\d+)/g,
];

export function outgoingIds(storage: string): string[] {
  const out = new Set<string>();
  for (const pattern of PAGE_HREFS) {
    for (const match of String(storage).matchAll(pattern)) out.add(match[1]);
  }
  return [...out];
}

export function neighbourhood(index: SpaceIndex, id: string, storage: string): Neighbourhood {
  const page = index.byId.get(id);
  if (!page) throw new Error(`page ${id} is not in this space index`);
  const parent = page.parentId ? index.byId.get(page.parentId) ?? null : null;
  const siblings = page.parentId
    ? [...index.byId.values()].filter((p) => p.parentId === page.parentId && p.id !== id)
    : [];
  const outgoing = outgoingIds(storage)
    .map((linked) => index.byId.get(linked))
    .filter((p): p is IndexedPage => Boolean(p) && p!.id !== id);
  return { page, parent, siblings, outgoing };
}
