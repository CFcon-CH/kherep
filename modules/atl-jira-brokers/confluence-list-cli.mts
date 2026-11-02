// The `list` verb, in its own file so confluence-neighbour-cli.mts stays under
// the line cap once stitch validates its three modes there (issue #736).
import { ConfluenceError, SCOPES, v1, type ConfluenceSession } from "./confluence-contract.mts";
import { neighbourDeps, positive, type NeighbourArgs, type NeighbourCliContext } from "./confluence-neighbour-cli.mts";
import { spaceIndex } from "./confluence-related.mts";
import { siteOrigin } from "./confluence-session.mts";

// Issue #315. The inventory `search` cannot give: every page of the space, read
// to exhaustion, optionally narrowed. The total is the count of pages read,
// never a size field the API reports. Nothing prints before every read has
// finished, so a failed read exits 1 without a total that looks measured.
export async function cmdList(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const limit = positive(args.limit, "--limit");
  const label = args.label?.trim();
  if (label === "") throw new ConfluenceError("--label is empty.");
  const { session, spaceId, spaceKey } = await neighbourDeps(ctx, args);
  const index = await spaceIndex(session, spaceId);
  const labelled = label === undefined ? null : await labelledIds(session, spaceKey, label);
  // Client-side on purpose: CQL `title ~` is fuzzy and stemmed, not a substring.
  const needle = (args["title-contains"] ?? "").toLowerCase();
  const pages = [...index.byId.values()].filter((page) =>
    page.title.toLowerCase().includes(needle) && (!labelled || labelled.has(page.id)));
  const shown = pages.slice(0, limit);
  const base = `${siteOrigin(ctx.env)}/wiki/spaces/${encodeURIComponent(spaceKey)}/pages`;
  for (const page of shown) ctx.log(`page\t${page.id}\t${page.title}\t${base}/${page.id}`);
  ctx.log(`total: ${pages.length}`);
  ctx.log(`shown: ${shown.length}`);
  ctx.log(`truncated: ${shown.length < pages.length}`);
  return 0;
}

// v2 has no label filter on the pages of a space, so this is one v1 CQL loop.
// Values are JSON-quoted, CQL's string syntax, so a quote in a label stays data.
// It follows _links.next and stops on a cursor that adds no new id.
async function labelledIds(session: ConfluenceSession, spaceKey: string, label: string): Promise<Set<string>> {
  const cql = `space=${JSON.stringify(spaceKey)} and type=page and label=${JSON.stringify(label)}`;
  const ids = new Set<string>();
  let path: string | null = v1(`/search?cql=${encodeURIComponent(cql)}&limit=250`);
  while (path) {
    const { json } = await session.request({ method: "GET", path, scope: SCOPES.get });
    const before = ids.size;
    const results = (json as { results?: unknown })?.results;
    for (const row of Array.isArray(results) ? results : []) {
      const id = (row as { content?: { id?: unknown } })?.content?.id;
      if (typeof id === "string" && id) ids.add(id);
    }
    const next = (json as { _links?: { next?: unknown } })?._links?.next;
    const link = typeof next === "string" ? next : "";
    path = link && ids.size > before ? (link.startsWith("/wiki") ? link : `/wiki${link}`) : null;
  }
  return ids;
}
