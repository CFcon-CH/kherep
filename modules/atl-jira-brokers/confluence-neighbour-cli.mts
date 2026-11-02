// The command wrappers for the four neighbour verbs. They live beside the
// behaviour rather than in the broker CLI for one reason: the broker CLI is the
// file everything else imports, and it is already at the size where a reader
// stops reading. Argument checking here, everything after it in
// confluence-neighbours.mts.
import { writeFile } from "node:fs/promises";

import { ConfluenceError } from "./confluence-contract.mts";
import { findSpace, getPageBody, listChildren, listLabels, movePage, updatePage } from "./confluence-content.mts";
import { reportContext, reportOrphans, reportRelated, type NeighbourDeps } from "./confluence-neighbours.mts";
import { spaceIndex } from "./confluence-related.mts";
import type { Proposals } from "./confluence-semantic.mts";
import { createSession, siteOrigin, type ConfluenceContext } from "./confluence-session.mts";
import { stitchCandidates, stitchDecisions, stitchSweep } from "./confluence-stitch.mts";

export interface NeighbourCliContext extends ConfluenceContext {
  log: (line: string) => void;
  logError: (line: string) => void;
  // The only dependency that reaches outside the Confluence API. Injected so a
  // test never spawns a process and a host without the tool fails loudly.
  semantic: (query: string, limit?: number, options?: { spaceKey?: string }) => Promise<Proposals>;
  // The payload channel: stdout, written as is. Only get --body-only uses it.
  writeOut: (chunk: string) => void;
  // Creates a new file and fails on an existing one. Only stitch --out uses it.
  writeNew?: (path: string, text: string) => Promise<void>;
}

export type NeighbourArgs = Record<string, string | undefined>;

export function positive(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ConfluenceError(`${flag} must be a positive whole number.`);
  return parsed;
}

// Every neighbour verb needs the space resolved first, so they share one setup.
export async function neighbourDeps(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<NeighbourDeps> {
  const session = createSession(ctx);
  const space = await findSpace(session, args.space ?? "");
  if (!space) throw new ConfluenceError("No space with that key is visible to the service account.");
  return {
    session,
    spaceId: space.id,
    spaceKey: space.key,
    log: ctx.log,
    logError: ctx.logError,
    semantic: ctx.semantic,
    // Only the stitching verb writes, and it reaches the write path through
    // here rather than importing it, so the read-only verbs cannot reach it.
    update: async (id, storage, message) => {
      await updatePage(session, { id, representation: "storage", value: storage, message });
    },
  };
}

export async function cmdRelated(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const title = (args.title ?? "").trim();
  if (!title) throw new ConfluenceError("--title is missing.");
  return await reportRelated(await neighbourDeps(ctx, args), {
    title,
    id: args.id,
    parentId: args.parent,
    limit: positive(args.limit, "--limit") ?? 3,
  });
}

export async function cmdContext(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const id = (args.id ?? "").trim();
  if (!id) throw new ConfluenceError("--id is missing.");
  return await reportContext(await neighbourDeps(ctx, args), id);
}

export async function cmdOrphans(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  return await reportOrphans(await neighbourDeps(ctx, args));
}

// Issue #736: exactly three flag combinations, each its own mode. Anything in
// between is refused before the space is looked up, so a half-formed call can
// neither search nor write.
const STITCH_MODES: Record<"sweep" | "candidate" | "write", { needs: string[]; allows: string[] }> = {
  sweep: { needs: [], allows: ["limit", "per-orphan"] },
  candidate: { needs: ["id", "topic", "out"], allows: ["per-orphan"] },
  write: { needs: ["id", "candidates", "decisions"], allows: [] },
};

function stitchMode(args: NeighbourArgs): keyof typeof STITCH_MODES {
  const given = Object.keys(args).filter((flag) => flag !== "space");
  const fits = (mode: keyof typeof STITCH_MODES) => {
    const { needs, allows } = STITCH_MODES[mode];
    return needs.every((flag) => given.includes(flag)) && given.every((flag) => needs.includes(flag) || allows.includes(flag));
  };
  const mode = (["sweep", "candidate", "write"] as const).find(fits);
  if (mode) return mode;
  throw new ConfluenceError("stitch takes one of three forms: --id <id> --topic <text> --out <receipt> (candidates),"
    + " --id <id> --candidates <receipt> --decisions <file> (write), or no --id with at most --limit and --per-orphan"
    + " (read-only sweep). Nothing was searched or written.");
}

export async function cmdStitch(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  // Issue #710: checked before the space is even looked up. A present --id that
  // names no page must never reach the sweep, which runs only without --id.
  if ("id" in args && !/^\d+$/.test((args.id ?? "").trim())) {
    throw new ConfluenceError("--id must be a numeric Confluence page id. Nothing was searched or written; the full-space sweep runs only without --id.");
  }
  const mode = stitchMode(args);
  const perPage = positive(args["per-orphan"], "--per-orphan");
  const limit = positive(args.limit, "--limit");
  if (mode === "candidate" && !(args.topic ?? "").trim()) {
    throw new ConfluenceError("--topic is empty. A title alone is not a topic; nothing was searched.");
  }
  const deps = {
    ...await neighbourDeps(ctx, args),
    now: ctx.now,
    readText: (path: string) => ctx.readFile(path, "utf8"),
    writeNew: ctx.writeNew ?? ((path: string, text: string) => writeFile(path, text, { flag: "wx" })),
  };
  const id = (args.id ?? "").trim();
  if (mode === "candidate") return await stitchCandidates(deps, { id, topic: args.topic ?? "", out: args.out ?? "", perPage });
  if (mode === "write") return await stitchDecisions(deps, { id, candidates: args.candidates ?? "", decisions: args.decisions ?? "" });
  return await stitchSweep(deps, { limit, perPage });
}

// OP-1440. The research lookup a turn makes BEFORE it answers: which pages in
// the knowledge space already say something about this question? Read-only; the
// semantic search proposes, the space index disposes exactly as for `related`
// (same space, leaf pages, proposal order kept), without the shared-word rule,
// because a question is not a title.
//
// Three outcomes, three exit codes, grep's convention: 0 hits, 1 the search ran
// and nothing in the space matched, 2 the search could not run. A search that
// never ran is UNKNOWN and must not read like a measured zero (golden rule 12).
export async function cmdSearch(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  try {
    const query = (args.query ?? "").trim();
    if (!query) throw new ConfluenceError("--query is missing.");
    const limit = positive(args.limit, "--limit") ?? 3;
    const deps = await neighbourDeps(ctx, args);
    const index = await spaceIndex(deps.session, deps.spaceId);
    // Issue #315: one ranked twg page of at most 100 proposals and no total.
    const asked = Math.min(Math.max(limit, 25), 100);
    const proposed = await deps.semantic(query, asked);
    if (proposed.error) {
      ctx.logError(proposed.error);
      throw new ConfluenceError("Nothing was searched, so nothing was found. This result is UNKNOWN, not zero.");
    }
    const hits = new Map<string, string>();
    let more = false; // a further leaf page of the space matched beyond --limit
    for (const title of proposed.titles) {
      const page = index.byTitle.get(title.trim().toLowerCase());
      if (!page || index.parents.has(page.id) || hits.has(page.id)) continue;
      if (hits.size >= limit) { more = true; break; }
      hits.set(page.id, page.title);
    }
    const base = `${siteOrigin(ctx.env)}/wiki/spaces/${encodeURIComponent(deps.spaceKey)}/pages`;
    for (const [id, title] of hits) {
      const evidence = await listLabels(deps.session, id)
        .then((labels) => labels.filter((label) => label.startsWith("evidence-")).join(",") || "no evidence label")
        .catch(() => "evidence UNKNOWN - labels not readable");
      ctx.log(`hit\t${id}\t${title}\t${evidence}\t${base}/${id}`);
    }
    ctx.log(`truncated: ${more || proposed.titles.length >= asked || limit > asked}`);
    ctx.log(`count: ${hits.size}`);
    ctx.log(`status: ${hits.size ? "hit" : "no match"}`);
    return hits.size ? 0 : 1;
  } catch (error) {
    ctx.logError(error instanceof ConfluenceError ? error.cliMessage : "Internal error.");
    ctx.log("status: unavailable");
    return 2;
  }
}

// Where a space is and what hangs directly under a page. They sit here rather
// than in the broker CLI for the same reason as the rest of this file: every
// one of them answers where something sits.
export async function cmdSpace(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const space = await findSpace(createSession(ctx), args.space ?? "");
  if (!space) {
    ctx.logError("No space with that key is visible to the service account.");
    return 1;
  }
  ctx.log(`id: ${space.id}`);
  ctx.log(`key: ${space.key}`);
  ctx.log(`name: ${space.name}`);
  return 0;
}

export async function cmdChildren(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const children = await listChildren(createSession(ctx), args.id ?? "");
  for (const child of children) ctx.log(`${child.id}\t${child.title}`);
  ctx.log(`count: ${children.length}`);
  return 0;
}

// Re-parenting: the verb that puts a page where it belongs. It sits here for the
// same reason as the two above - it answers where something sits - and it is the
// only one of them that changes the answer.
//
// The report comes from the TARGET, not from the write. A PUT that returns 200
// says the request was accepted; the new parent's own child list is what says
// the page arrived (golden rule 13). The list is read to exhaustion by
// listChildren, so "not among them" is a measured absence rather than the first
// 25 entries.
export async function cmdMove(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const session = createSession(ctx);
  const result = await movePage(session, args.id ?? "", args.parent ?? "");
  // An empty fromParent is a page that hung at the space root, which is exactly
  // the case this verb exists to repair. It is named, not printed as blank.
  ctx.log(`from parent: ${result.fromParent || "none - the page hung at the space root"}`);
  ctx.log(`to parent: ${result.toParent}`);
  ctx.log(`version: ${result.page.version}`);
  const pageId = result.page.id || (args.id ?? "").trim();
  const children = await listChildren(session, result.toParent);
  ctx.log(`children at target: ${children.length}`);
  if (!children.some((child) => child.id === pageId)) {
    ctx.logError(`Page ${pageId} is not among the children of ${result.toParent}. The move is UNVERIFIED.`);
    return 1;
  }
  ctx.log(`readback parent: ${result.toParent}`);
  return 0;
}

const BODY_FORMATS = { storage: "storage", adf: "atlas_doc_format" } as const;

// get --body-only: stdout carries the body and nothing else, without an added
// newline, so `get --id <page> --body-only > page.xml` is exactly the body. The
// broker writes no file; the shell names it. Every other line goes to stderr.
// --format is checked here, before any request, and is refused without
// --body-only rather than silently ignored.
export async function cmdGetBody(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  if (!("body-only" in args)) throw new ConfluenceError("get --format applies only with --body-only.");
  // Present without a value is an empty format and refused, not the default.
  const format = "format" in args ? args.format ?? "" : "storage";
  if (!Object.hasOwn(BODY_FORMATS, format)) {
    throw new ConfluenceError(`--format "${format}" is not readable by get --body-only. Use storage or adf.`);
  }
  const representation = BODY_FORMATS[format as keyof typeof BODY_FORMATS];
  ctx.writeOut(await getPageBody(createSession(ctx), args.id ?? "", representation));
  return 0;
}
