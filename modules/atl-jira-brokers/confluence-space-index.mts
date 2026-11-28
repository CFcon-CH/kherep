// The space inventory: every current page of one space, read to exhaustion
// and never returned partial. Moved out of confluence-related.mts, which
// re-exports it, to keep that file below the size limit (issue #1020).
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
