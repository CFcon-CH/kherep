// The three answers the linking contract needs: which pages does this one
// belong next to, what sits around an existing page, and which pages does
// nothing point at. Argument parsing stays in the CLI; what happens once the
// arguments are understood happens here.
import type { ConfluenceSession } from "./confluence-contract.mts";
import {
  neighbourhood,
  outgoingIds,
  pageStorage,
  selectRelated,
  spaceIndex,
  type IndexedPage,
  type SpaceIndex,
} from "./confluence-related.mts";
import type { Proposals } from "./confluence-semantic.mts";
import { textFailureLine, textSearch } from "./confluence-text-search.mts";

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
  // Set when the page already exists: it is never its own neighbour.
  id?: string;
  // Set when the page already hangs somewhere, or is about to.
  parentId?: string | null;
  limit?: number;
}

// The call the observation agent makes BEFORE it writes. It answers one
// question: which existing pages does this one belong next to?
//
// An empty answer is a real answer - but only when the search actually ran.
// With the ranking half dead, or the exact half not fully read, "nothing found"
// is not a measured absence, so it is reported as UNKNOWN and the exit code
// says so (golden rule 12).
export async function reportRelated(deps: NeighbourDeps, request: RelatedRequest): Promise<number> {
  const index = await spaceIndex(deps.session, deps.spaceId);
  const limit = request.limit ?? 3;

  const proposed = await deps.semantic(request.title);
  const exact = await textSearch(deps.session, deps.spaceKey, request.title);
  const related = selectRelated(
    index,
    { title: request.title, id: request.id, parentId: request.parentId ?? null },
    [...proposed.titles, ...exact.titles],
    limit,
  );

  printRows(deps, "related", related);
  deps.log(`count: ${related.length}`);
  const failed: string[] = [];
  if (proposed.error) failed.push(proposed.error);
  if (exact.failure) failed.push(textFailureLine(exact));
  if (!failed.length) return 0;

  for (const line of failed) deps.logError(line);
  const partial = exact.failure?.kind === "rows";
  if (related.length) {
    // Unread rows may hide further hits; with a rows failure the hits shown may
    // come from either half, so no half is named (issue #656).
    if (partial) {
      deps.logError("The exact-term half was not fully read. The list may be incomplete.");
    } else {
      deps.logError(`These hits come from the ${exact.failure ? "semantic" : "exact-term"} half only. The list may be incomplete.`);
    }
    return 0;
  }
  // A rows failure is a request that ran and came back unreadable: neither
  // "never searched" nor "one half ran" describes it. The other two keep their
  // pre-existing wording, alone or together.
  if (partial) {
    deps.logError("The exact-term half was not fully read and nothing was found. This result is UNKNOWN, not zero.");
  } else if (proposed.error) {
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
    .replace(/"/g, "&quot;");
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

// Gives every orphan an incoming link by writing a Related block on the pages
// it belongs next to. Outgoing links do not help an orphan - by definition it
// is the target nobody names - so the write lands on the NEIGHBOUR, not on the
// orphan itself. That inversion is the whole point of this function.
export async function reportStitch(
  deps: NeighbourDeps,
  options: { limit?: number; perOrphan?: number; dryRun?: boolean; only?: string } = {},
): Promise<number> {
  // Two entry points, because they cost differently. The sweep has to read
  // every body in the space to know what an orphan is. A page that was just
  // written is known to be one without asking, and the agent that wrote it
  // must not pay for a full-space read to link its own page.
  let index: SpaceIndex;
  let work: IndexedPage[];
  let orphanCount: number;
  // Issue #710: a supplied id selects the targeted mode, even an empty one. An
  // empty id is a caller that lost its page, not a request for the sweep; on
  // 2026-10-31 that fall-through wrote to 127 unrelated pages.
  if (options.only !== undefined) {
    const only = options.only.trim();
    if (!/^\d+$/.test(only)) {
      deps.logError("--id must be a numeric Confluence page id. Nothing was searched or written.");
      return 1;
    }
    index = await spaceIndex(deps.session, deps.spaceId);
    const page = index.byId.get(only);
    if (!page) {
      deps.logError("That id is not a page in this space.");
      return 1;
    }
    work = [page];
    orphanCount = 1;
  } else {
    const found = await findOrphans(deps);
    index = found.index;
    work = options.limit ? found.orphans.slice(0, options.limit) : found.orphans;
    orphanCount = found.orphans.length;
  }
  const assignment = new Map<string, Set<string>>();
  let unsearched = 0;
  let isolated = 0;

  // Progress, because this call spends minutes waiting on the network and
  // silence is indistinguishable from a hang. Two runs were left going for two
  // hours on 2026-09-21 for exactly that reason.
  let scanned = 0;
  for (const orphan of work) {
    if (++scanned % 10 === 0) deps.log(`searched ${scanned}/${work.length}`);
    const proposed = await deps.semantic(orphan.title);
    if (proposed.error) { deps.logError(`unsearched\t${orphan.id}\t${proposed.error}`); unsearched += 1; continue; }
    // A half-run search is half evidence: skip the page rather than write a
    // link nothing distinguishes from a measured one (issue #651), also when
    // the exact half returned rows that could not be read (issue #656).
    const exact = await textSearch(deps.session, deps.spaceKey, orphan.title);
    if (exact.failure) { deps.logError(`unsearched\t${orphan.id}\t${textFailureLine(exact)}`); unsearched += 1; continue; }
    const neighbours = selectRelated(
      index,
      { title: orphan.title, id: orphan.id, parentId: orphan.parentId },
      [...proposed.titles, ...exact.titles],
      options.perOrphan ?? 2,
    );
    if (!neighbours.length) { isolated += 1; continue; }
    for (const neighbour of neighbours) {
      // One line per link with the words that justified it, so a wrong link
      // can be traced to its cause instead of only reverted (issue #86).
      const trace = `term=${neighbour.terms.join(",")}${neighbour.sibling ? "\tsibling" : ""}`;
      deps.log(`link\t${neighbour.id}\t${orphan.id}\t${trace}`);
      const targets = assignment.get(neighbour.id) ?? new Set<string>();
      targets.add(orphan.id);
      assignment.set(neighbour.id, targets);
    }
  }

  let written = 0;
  let unchanged = 0;
  for (const [pageId, orphanIds] of assignment) {
    const storage = await pageStorage(deps.session, pageId);
    const linked = existingRelated(storage);
    const merged = [...new Set([...linked, ...orphanIds])].filter((id) => id !== pageId && index.byId.has(id));
    // Issue #479: Confluence may hand our block back re-serialized; the ids decide.
    if (merged.length === linked.length && merged.every((id) => linked.includes(id))) { unchanged += 1; continue; }
    const next = withRelated(storage, relatedSection(deps.spaceKey, merged.map((id) => index.byId.get(id)!)));
    if (!options.dryRun) {
      await deps.update(pageId, next, "OP-1409 link the pages nothing pointed at");
    }
    written += 1;
    deps.log(`stitch\t${pageId}\t${index.byId.get(pageId)?.title ?? ""}\t+${orphanIds.size}`);
  }

  deps.log(`orphans: ${orphanCount}`);
  deps.log(`pages ${options.dryRun ? "that would be written" : "written"}: ${written}`);
  deps.log(`unchanged: ${unchanged}`);
  deps.log(`isolated: ${isolated}`);
  // Golden rule 12 again: an orphan whose search never ran is not an orphan
  // without neighbours, and the two must not be reported as one number.
  if (unsearched) deps.logError(`${unsearched} orphan(s) were never searched. Their neighbours are UNKNOWN.`);
  return unsearched ? 1 : 0;
}
