import { SCOPES, v2, type ConfluenceSession } from './confluence-contract.mts';
import { nextPath, strictRows, ReadFailure } from './confluence-pagination.mts';
import type { Snapshot } from './confluence-drainage-rules.mts';

async function labels(session: ConfluenceSession, id: string): Promise<string[]> {
  const endpoint = v2(`/pages/${id}/labels`);
  let path: string | null = `${endpoint}?limit=250`;
  const visited = new Set<string>();
  const names = new Set<string>();
  while (path) {
    if (visited.has(path)) throw new ReadFailure('label-pagination-loop');
    visited.add(path);
    const {json} = await session.request({method:'GET',path,scope:SCOPES.get});
    const before = names.size;
    for (const row of strictRows(json)) {
      if (typeof row.name !== 'string' || !row.name) throw new ReadFailure('malformed-label');
      names.add(row.name);
    }
    path = nextPath(json,endpoint);
    if (path && names.size === before) throw new ReadFailure('stalled-label-pagination');
  }
  return [...names].sort((left, right) => Number(left > right) - Number(left < right));
}
async function page(session: ConfluenceSession, id: string, spaceId: string): Promise<Omit<Snapshot,'labels'>> {
  const {json} = await session.request({method:'GET',path:v2(`/pages/${id}?body-format=storage`),scope:SCOPES.get});
  const p = json as {id?:unknown;title?:unknown;spaceId?:unknown;parentId?:unknown;status?:unknown;
    version?:{number?:unknown};body?:{storage?:{value?:unknown}}} | null;
  const version = p?.version?.number;
  if (p?.id !== id || p.spaceId !== spaceId || typeof p.title !== 'string' || p.status !== 'current'
    || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
    || typeof p.body?.storage?.value !== 'string'
    || (p.parentId !== undefined && p.parentId !== null && typeof p.parentId !== 'string')) {
    throw new ReadFailure('malformed-moved-or-unreadable-page');
  }
  return {id,title:p.title,spaceId,version,parentId: typeof p.parentId === 'string' ? p.parentId : null,body:p.body.storage.value};
}
// Bracket independent label reads and detect observed drift. This is not an atomic API snapshot.
export async function drainageSnapshot(session: ConfluenceSession, id: string, spaceId: string): Promise<Snapshot> {
  const before = await page(session,id,spaceId);
  const firstLabels = await labels(session,id);
  const after = await page(session,id,spaceId);
  const afterLabels = await labels(session,id);
  if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(firstLabels) !== JSON.stringify(afterLabels)) {
    throw new ReadFailure('snapshot-drift');
  }
  return {...after,labels:afterLabels};
}
