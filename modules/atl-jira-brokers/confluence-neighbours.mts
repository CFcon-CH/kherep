// The three answers the linking contract needs: which pages does this one
// belong next to, what sits around an existing page, and which pages does
// nothing point at. Argument parsing stays in the CLI; what happens once the
// arguments are understood happens here.
import { candidateRow, proposalItems, selectCandidates, type Candidate } from "./confluence-candidates.mts";
import type { ConfluenceSession } from "./confluence-contract.mts";
import {
  neighbourhood,
  outgoingIds,
  pageStorage,
  spaceIndex,
  type IndexedPage,
  type SpaceIndex,
} from "./confluence-related.mts";
import type { Proposals } from "./confluence-semantic.mts";
import { textFailureLine, textSearch } from "./confluence-text-search.mts";
import { topicQuery } from "./confluence-topic-query.mts";

export interface NeighbourDeps {
  session: ConfluenceSession;
  spaceId: string;
  spaceKey: string;
  log: (line: string) => void;
  logError: (line: string) => void;
  semantic: (query: string, limit?: number, options?: { spaceKey?: string }) => Promise<Proposals>;
  // Only the stitching call writes. It is injected rather than imported so the
  // read-only calls cannot reach a write path at all.
  update: (id: string, storage: string, message: string) => Promise<void>;
}

function printRows(deps: NeighbourDeps, label: string, rows: { id: string; title: string }[]): void {
  for (const row of rows) deps.log(`${label}\t${row.id}\t${row.title}`);
}

export interface RelatedRequest {
  title: string;
  // The finding sentence (issue #736). The query is title plus topic; a bare
  // title is the weakest topic signal a page has.
  topic?: string;
  // Set when the page already exists: it is never its own neighbour.
  id?: string;
  limit?: number;
}

export interface RelatedResult {
  query: string;
  candidates: Candidate[];
  // One line per half that did not run completely. Empty: both halves ran.
  failed: string[];
  semanticFailed: boolean;
  exactFailed: false | "http" | "rows";
}

// The search behind `related`, shared with the Codex adapter. It proposes and
// filters by structure only: shared title words are reported as a hint and no
// longer drop a row, because the reader of the rows decides on topic.
export async function findRelated(deps: NeighbourDeps, request: RelatedRequest): Promise<RelatedResult> {
  const index = await spaceIndex(deps.session, deps.spaceId);
  const query = topicQuery(request.title, request.topic);
  const proposed = await deps.semantic(query, undefined, { spaceKey: deps.spaceKey });
  const exact = await textSearch(deps.session, deps.spaceKey, request.title);
  const candidates = selectCandidates(index, { id: request.id, title: request.title }, proposalItems(proposed), exact.titles, request.limit ?? 3);
  const failed: string[] = [];
  if (proposed.error) failed.push(proposed.error);
  if (exact.failure) failed.push(textFailureLine(exact));
  return { query, candidates, failed, semanticFailed: Boolean(proposed.error), exactFailed: exact.failure?.kind ?? false };
}

// The call the observation agent makes BEFORE it writes. It answers one
// question: which existing pages might this one belong next to? Each row is
// `related<TAB>id<TAB>title<TAB>area<TAB>terms<TAB>snippet`.
//
// An empty answer is a real answer - but only when the search actually ran.
// With the ranking half dead, or the exact half not fully read, "nothing found"
// is not a measured absence, so it is reported as UNKNOWN and the exit code
// says so (golden rule 12).
export async function reportRelated(deps: NeighbourDeps, request: RelatedRequest): Promise<number> {
  const { candidates: related, failed, semanticFailed, exactFailed } = await findRelated(deps, request);
  for (const candidate of related) deps.log(`related\t${candidateRow(candidate)}`);
  deps.log(`count: ${related.length}`);
  if (!failed.length) return 0;

  for (const line of failed) deps.logError(line);
  const partial = exactFailed === "rows";
  if (related.length) {
    // Unread rows may hide further hits; with a rows failure the hits shown may
    // come from either half, so no half is named (issue #656).
    if (partial) {
      deps.logError("The exact-term half was not fully read. The list may be incomplete.");
    } else {
      deps.logError(`These hits come from the ${exactFailed ? "semantic" : "exact-term"} half only. The list may be incomplete.`);
    }
    return 0;
  }
  // A rows failure is a request that ran and came back unreadable: neither
  // "never searched" nor "one half ran" describes it. The other two keep their
  // pre-existing wording, alone or together.
  if (partial) {
    deps.logError("The exact-term half was not fully read and nothing was found. This result is UNKNOWN, not zero.");
  } else if (semanticFailed) {
    deps.logError("Nothing was searched, so nothing was found. This result is UNKNOWN, not zero.");
  } else {
    deps.logError("Only one half of the search ran and it found nothing. This result is UNKNOWN, not zero.");
  }
  return 1;
}

// The neighbourhood of an existing page: what it hangs under, what sits beside
// it, what it points at. Knowing a page's neighbours is the difference between
// a search result and context.
export async function reportContext(deps: NeighbourDeps, id: string): Promise<number> {
  const index = await spaceIndex(deps.session, deps.spaceId);
  if (!index.byId.has(id)) {
    deps.logError("That id is not a page in this space.");
    return 1;
  }
  const near = neighbourhood(index, id, await pageStorage(deps.session, id));
  deps.log(`page\t${near.page.id}\t${near.page.title}`);
  if (near.parent) deps.log(`parent\t${near.parent.id}\t${near.parent.title}`);
  printRows(deps, "outgoing", near.outgoing);
  printRows(deps, "sibling", near.siblings);
  deps.log(`outgoing: ${near.outgoing.length}`);
  deps.log(`siblings: ${near.siblings.length}`);
  return 0;
}

// Lists the pages nothing in the space links to. It reads every body, so it is
// the expensive call - and the only one that can prove an orphan, because an
// incoming link is not a property a page carries. Structure nodes are excluded:
// a shelf is reached by the hierarchy, not by a link, so calling one an orphan
// would bury the real ones in noise.
export async function findOrphans(
  deps: NeighbourDeps,
): Promise<{ index: SpaceIndex; orphans: IndexedPage[] }> {
  const index = await spaceIndex(deps.session, deps.spaceId);
  const linked = new Set<string>();
  for (const page of index.byId.values()) {
    for (const target of outgoingIds(await pageStorage(deps.session, page.id))) linked.add(target);
  }
  const orphans = [...index.byId.values()]
    .filter((page) => !index.parents.has(page.id) && !linked.has(page.id));
  return { index, orphans };
}

export async function reportOrphans(deps: NeighbourDeps): Promise<number> {
  const { index, orphans } = await findOrphans(deps);
  printRows(deps, "orphan", orphans);
  deps.log(`pages: ${index.byId.size}`);
  deps.log(`count: ${orphans.length}`);
  return 0;
}

// The heading that owns the block. Everything from the LAST occurrence to the
// end of the body belongs to this tool, which is what makes rewriting it
// idempotent instead of appending a new list on every run. The string is ours:
// no page in this space carries it except the ones written here.
export const RELATED_HEADING = "<h2>Related pages</h2>";

// Storage format is XHTML, so a title is not text until it is escaped. This is
// not a hypothetical: page titles in this space contain "&" and "<", and an
// unescaped one produces a body Confluence either rejects or renders wrongly.
// The same escape closes the injection path, where a title decides what markup
// the next page carries.
function xml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\u2018/g, "&lsquo;")
    .replace(/\u2019/g, "&rsquo;");
}

export function relatedSection(spaceKey: string, rows: { id: string; title: string }[]): string {
  const items = rows
    .map((row) => {
      const href = `/wiki/spaces/${encodeURIComponent(spaceKey)}/pages/${encodeURIComponent(row.id)}`;
      // Match stored XHTML before submission so exact readback stays strict:
      // Modeled storage serialization wraps list anchors and stores text ' raw.
      return `<li><p><a href="${xml(href)}">${xml(row.title)}</a></p></li>`;
    })
    .join("");
  return `${RELATED_HEADING}<ul>${items}</ul>`;
}

export function withRelated(storage: string, section: string): string {
  const at = storage.lastIndexOf(RELATED_HEADING);
  const body = at >= 0 ? storage.slice(0, at) : storage;
  return `${body.trimEnd()}${section}`;
}

// What the block already points at. A run that ignored this would drop the
// neighbours an earlier run wrote, turn those pages back into orphans, and
// rediscover them next time: a sweep that undoes its own previous sweep.
export function existingRelated(storage: string): string[] {
  const at = storage.lastIndexOf(RELATED_HEADING);
  return at < 0 ? [] : outgoingIds(storage.slice(at));
}
