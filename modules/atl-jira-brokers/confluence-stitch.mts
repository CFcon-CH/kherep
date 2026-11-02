// Linking a page from the pages it belongs next to, without the broker ever
// deciding a link (issue #736). Three modes:
//
//   candidate  stitch --id X --topic T --out R   searches, prints candidates and
//              writes receipt R. Read-only towards Confluence.
//   write      stitch --id X --candidates R --decisions D   writes the backlink
//              on exactly the targets D approves, each with a reason, and only
//              when every target is a candidate of R.
//   sweep      stitch (no --id)   lists candidates per orphan. Read-only.
//
// The old path chose neighbours by shared title words and wrote them. Rare
// shared words were still the wrong topic often enough to be a recurring bug
// (#86, #736), so that path is gone rather than switched off.
import { checkDecisions, candidateRow, parseDecisions, parseReceipt, RECEIPT_KIND, selectCandidates,
  type Candidate, type StitchReceipt } from "./confluence-candidates.mts";
import { existingRelated, findOrphans, relatedSection, withRelated, type NeighbourDeps } from "./confluence-neighbours.mts";
import { pageStorage, spaceIndex, type IndexedPage, type SpaceIndex } from "./confluence-related.mts";
import { textFailureLine, textSearch } from "./confluence-text-search.mts";
import { bodyTopic, topicQuery } from "./confluence-topic-query.mts";

export interface StitchDeps extends NeighbourDeps {
  now: () => number;
  readText: (path: string) => Promise<string>;
  // Creates a new file and refuses one that exists: a receipt is never reused.
  writeNew: (path: string, text: string) => Promise<void>;
}

export const SEARCH_LIMIT = 25;
export const DEFAULT_PER_PAGE = 5;

// Both halves have to run completely, or the candidate set is UNKNOWN: a
// half-read search is half evidence (issues #651, #656).
async function searchCandidates(
  deps: StitchDeps, index: SpaceIndex, page: IndexedPage, query: string, limit: number,
): Promise<{ candidates: Candidate[] } | { error: string }> {
  const proposed = await deps.semantic(query, SEARCH_LIMIT, { spaceKey: deps.spaceKey });
  if (proposed.error) return { error: proposed.error };
  const exact = await textSearch(deps.session, deps.spaceKey, page.title);
  if (exact.failure) return { error: textFailureLine(exact) };
  const items = proposed.items ?? proposed.titles.map((title) => ({ id: "", title, snippet: "" }));
  return { candidates: selectCandidates(index, page, items, exact.titles, limit) };
}

export async function stitchCandidates(
  deps: StitchDeps, options: { id: string; topic: string; out: string; perPage?: number },
): Promise<number> {
  // A title-only query is exactly the bug this mode exists to end.
  if (!options.topic.trim()) {
    deps.logError("--topic is empty. A title alone is not a topic; nothing was searched.");
    return 1;
  }
  const index = await spaceIndex(deps.session, deps.spaceId);
  const page = index.byId.get(options.id);
  if (!page) {
    deps.logError("That id is not a page in this space.");
    return 1;
  }
  const query = topicQuery(page.title, options.topic);
  const found = await searchCandidates(deps, index, page, query, options.perPage ?? DEFAULT_PER_PAGE);
  if ("error" in found) {
    deps.logError(`unsearched\t${page.id}\t${found.error}`);
    deps.logError("The search did not run completely. The candidates are UNKNOWN; no receipt was written.");
    return 1;
  }
  const receipt: StitchReceipt = {
    kind: RECEIPT_KIND, source: page.id, spaceKey: deps.spaceKey, query,
    searchedAt: new Date(deps.now()).toISOString(), candidates: found.candidates,
  };
  try {
    await deps.writeNew(options.out, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    const code = (error as { code?: unknown })?.code === "EEXIST" ? "it already exists" : "it could not be created";
    deps.logError(`--out was not written: ${code}. A receipt is always a new file; nothing was printed as a candidate.`);
    return 1;
  }
  for (const candidate of found.candidates) deps.log(`candidate\t${candidateRow(candidate)}`);
  // Forward slashes: the agent types this path into a Bash call, where a
  // Windows backslash would be eaten (issue #280).
  deps.log(`receipt\t${options.out.split("\\").join("/")}`);
  deps.log(`count: ${found.candidates.length}`);
  return 0;
}

async function readOrNull(deps: StitchDeps, path: string): Promise<string | null> {
  try { return await deps.readText(path); } catch { return null; }
}

export async function stitchDecisions(
  deps: StitchDeps, options: { id: string; candidates: string; decisions: string },
): Promise<number> {
  const refuse = (problems: { id: string; why: string }[]) => {
    for (const problem of problems) deps.log(`refused\t${problem.id}\t${problem.why}`);
    deps.logError("Nothing was written.");
    return 1;
  };
  const receiptText = await readOrNull(deps, options.candidates);
  const decisionsText = await readOrNull(deps, options.decisions);
  if (receiptText === null) return refuse([{ id: options.id, why: "--candidates is not readable" }]);
  if (decisionsText === null) return refuse([{ id: options.id, why: "--decisions is not readable" }]);
  const receipt = parseReceipt(receiptText);
  const decisions = parseDecisions(decisionsText);
  const problems = checkDecisions(receipt, decisions, { source: options.id, spaceKey: deps.spaceKey, now: deps.now() });
  if (problems.length || !receipt) return refuse(problems);
  const approved = decisions.map((decision) => ({
    ...decision, area: receipt.candidates.find((candidate) => candidate.id === decision.id)?.area ?? "",
  }));
  return await writeApproved(deps, options.id, approved, (decision) => `Related pages: link ${options.id}. ${decision.reason}`);
}

export interface Approved {
  id: string;
  reason: string;
  area: string;
}

// The write half, for decisions that were already checked against a receipt:
// the CLI's decisions file, or the Codex adapter's approved list in memory.
export async function writeApproved(
  deps: NeighbourDeps, source: string, approved: readonly Approved[], message: (decision: Approved) => string,
): Promise<number> {
  if (!approved.length) {
    deps.log(`nolink\t${source}\tno candidate on topic`);
    return 0;
  }
  // The space as it is now, checked for every target before the first PUT.
  const index = await spaceIndex(deps.session, deps.spaceId);
  const late = [source, ...approved.map((decision) => decision.id)]
    .filter((id) => !index.byId.has(id) || (id !== source && index.parents.has(id)))
    .map((id) => ({ id, why: index.byId.has(id) ? "the page has become a shelf" : "not a page in this space" }));
  if (late.length) {
    for (const problem of late) deps.log(`refused\t${problem.id}\t${problem.why}`);
    deps.logError("Nothing was written.");
    return 1;
  }

  let written = 0;
  let unchanged = 0;
  for (const decision of approved) {
    const target = decision.id;
    // One trace line per approved link: the reason travels with the link, so a
    // wrong one can be traced to the judgment that let it through.
    deps.log(`link\t${target}\t${source}\treason=${decision.reason}\tarea=${decision.area}`);
    const storage = await pageStorage(deps.session, target);
    const linked = existingRelated(storage);
    const merged = [...new Set([...linked, source])].filter((id) => id !== target && index.byId.has(id));
    // Issue #479: Confluence may hand our block back re-serialized; the ids decide.
    if (merged.length === linked.length && merged.every((id) => linked.includes(id))) { unchanged += 1; continue; }
    const next = withRelated(storage, relatedSection(deps.spaceKey, merged.map((id) => index.byId.get(id)!)));
    await deps.update(target, next, message(decision));
    written += 1;
    deps.log(`stitch\t${target}\t${index.byId.get(target)?.title ?? ""}\t+1`);
  }
  deps.log(`pages written: ${written}`);
  deps.log(`unchanged: ${unchanged}`);
  return 0;
}

// The full-space sweep lists and never writes. Its topic per orphan is the
// opening of the orphan's own body, the nearest thing it has to a finding.
export async function stitchSweep(deps: StitchDeps, options: { limit?: number; perPage?: number } = {}): Promise<number> {
  const found = await findOrphans(deps);
  const work = options.limit ? found.orphans.slice(0, options.limit) : found.orphans;
  let unsearched = 0;
  let without = 0;
  let scanned = 0;
  for (const orphan of work) {
    // Progress: this call waits on the network for minutes (2026-09-21).
    if (++scanned % 10 === 0) deps.log(`searched ${scanned}/${work.length}`);
    const query = topicQuery(orphan.title, bodyTopic(await pageStorage(deps.session, orphan.id)));
    const result = await searchCandidates(deps, found.index, orphan, query, options.perPage ?? DEFAULT_PER_PAGE);
    if ("error" in result) { deps.logError(`unsearched\t${orphan.id}\t${result.error}`); unsearched += 1; continue; }
    deps.log(`orphan\t${orphan.id}\t${orphan.title}`);
    for (const candidate of result.candidates) deps.log(`candidate\t${candidateRow(candidate)}`);
    if (!result.candidates.length) without += 1;
  }
  deps.log(`orphans: ${found.orphans.length}`);
  deps.log(`without candidates: ${without}`);
  deps.log("pages written: 0 (the sweep is read-only; link with stitch --id and decisions)");
  // Golden rule 12: an orphan whose search never ran has UNKNOWN neighbours.
  if (unsearched) deps.logError(`${unsearched} orphan(s) were never searched. Their candidates are UNKNOWN.`);
  return unsearched ? 1 : 0;
}
