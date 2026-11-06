// Issue #701. A worker that builds or reviews code states the revision it works
// on and the decisions already made, so its result can be bound to that
// revision and its assumptions surface instead of being resolved silently.
//
// A brief declares revision and decisions with lowercase markers at the start of a line,
// optionally after whitespace and a list bullet (-, *) or a list number (1. or
// 1)), the grammar of the observation brief markers (obs-brief-policy.mts).
// A `decided:` marker's text runs to the next marker or the end of the brief,
// so one marker may carry a multi-line list. A `revision:` marker's tokens are
// the rest of its own line, so brief text after that line is never read as a
// token; several repositories take several tokens or several lines.
//
// Both dispatch guards apply these checks. They check that the fields are
// present and well formed, never git state and never completeness. Pure: no
// I/O, no imports, and a reason never quotes the brief.

// The deny reason states this sentence; both ROUTING files name the rule.
export const WORKER_BRIEF_FORMAT =
  "A code-bound dispatch states revision: <name>@<sha> for a build or <name>@<base>..<head> for a review, "
  + "the full 40-hex SHA from `git rev-parse HEAD` of the checkout, -dirty when that tree had uncommitted changes, "
  + "and decided: <decisions and assumptions already made> or decided: none. "
  + "A build also states test-route: <execution context> :: <functional check> :: <retrievable result> and "
  + "route-source: page <safe reference> | query <safe terms> :: hit <safe finding> | query <safe terms> :: no-match.";
// The notice states this sentence; it is never a deny.
export const WORKER_BRIEF_REVISION =
  "A review of repository code states revision: <name>@<base>..<head> and decided: ... so the reviewer reports "
  + "from the named revision; ignore this when the task is not a code review.";
// Quoted verbatim in both ROUTING files and pasted into every review brief
// (bootstrap/worker-brief-contract.test.mts pins it). No guard checks it.
export const REVIEW_ASSUMPTION_RULE =
  "A finding that rests on an assumption stated neither in the brief nor in the code is reported as "
  + "`assumed: <assumption> -> <finding>` and counted in ASSUMED:, never resolved silently.";

const BUILD_MARKER = /^[ \t]*(?:(?:[-*]|\d+[.)])[ \t]*)?(revision|decided|test-route|route-source):/gm;
const MARKER = /^[ \t]*(?:(?:[-*]|\d+[.)])[ \t]*)?(revision|decided):/gm;
// Copied from obs-brief-policy.mts, not imported: each lib is loaded alone by a
// computed path on Codex. bootstrap/worker-brief-contract.test.mts pins both equal.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const SHA = /^[0-9a-f]{40}$/;
const REVIEW_WORD = /\breview(?:s|ed|ing|er)?\b/i;

interface Field {
  kind: string;
  text: string;
}

function fields(brief: string, codeBound = false): Field[] {
  const marks = [...brief.matchAll(codeBound ? BUILD_MARKER : MARKER)];
  return marks.map((mark, index) => ({
    kind: mark[1],
    text: brief.slice(mark.index + mark[0].length, marks[index + 1]?.index ?? brief.length),
  }));
}

// <name>@<sha> or <name>@<base>..<head>, -dirty optionally appended.
function wellFormed(token: string): boolean {
  const at = token.indexOf("@");
  if (at <= 0 || !NAME.test(token.slice(0, at))) return false;
  const revision = token.slice(at + 1).replace(/-dirty$/, "");
  const shas = revision.split("..");
  return shas.length <= 2 && shas.every((sha) => SHA.test(sha));
}

const tokens = (field: Field) => field.text.split(/\r?\n/, 1)[0].split(/\s+/).filter(Boolean);

// The first problem in this order: a missing marker on a code-bound brief, a
// malformed token, a revision: without a token, an empty decided:.
function firstProblem(list: Field[], codeBound: boolean): string | null {
  for (const kind of codeBound ? ["revision", "decided"] : []) {
    if (!list.some((field) => field.kind === kind)) return `the brief names no ${kind}:`;
  }
  const revisions = list.filter((field) => field.kind === "revision");
  const malformed = revisions.findIndex((field) => !tokens(field).every(wellFormed));
  if (malformed >= 0) return `revision ${malformed + 1} has a malformed token`;
  const bare = revisions.findIndex((field) => !tokens(field).length);
  if (bare >= 0) return `revision ${bare + 1} names no repository`;
  const empty = list.filter((field) => field.kind === "decided").findIndex((field) => !field.text.trim());
  return empty >= 0 ? `decided ${empty + 1} is empty` : null;
}

// Build routes are single-line declarations. Continuation prose cannot fill
// a missing component. Placeholder checks are syntactic, never provenance.
const line = (field: Field) => field.text.split(/\r?\n/, 1)[0].trim();
const actual = (text: string) => Boolean(text.trim())
  && !/^(?:TBD|TODO|UNKNOWN|none|refused|unavailable|N\/A|\.\.\.)$/i.test(text.trim())
  && !/^(?:<[^>]*>|\{\{.*\}\}|\$\{.*\}|\[[^\]]*\])$/.test(text.trim());

function validTestRoute(value: string): boolean {
  const parts = value.split(" :: ");
  return parts.length === 3 && parts.every(actual);
}

function validRouteSource(value: string): boolean {
  if (value.startsWith("page ")) return !value.includes(" :: ") && actual(value.slice(5));
  const parts = value.split(" :: ");
  if (parts.length !== 2 || !parts[0].startsWith("query ") || !actual(parts[0].slice(6))) return false;
  const outcome = parts[1].trim();
  return outcome === "no-match" || (outcome.startsWith("hit ") && actual(outcome.slice(4)));
}

function routeProblem(list: Field[]): string | null {
  for (const [kind, valid] of [["test-route", validTestRoute], ["route-source", validRouteSource]] as const) {
    const routes = list.filter((field) => field.kind === kind);
    if (!routes.length) return `the brief names no ${kind}:`;
    const invalid = routes.findIndex((field) => !valid(line(field)));
    if (invalid >= 0) return `${kind} ${invalid + 1} is malformed`;
  }
  return null;
}

export function declaresRevision(brief: string): boolean {
  return fields(brief).some((field) => field.kind === "revision");
}

// null when the brief passes, else the deny reason. A code-bound dispatch
// needs revision, decisions and both route fields; any other dispatch is
// checked only when it declares revision:, and then every marker it carries must be well formed.
export function workerBriefIssue(brief: string, codeBound: boolean): string | null {
  const list = fields(brief, codeBound);
  if (!codeBound && !list.some((field) => field.kind === "revision")) return null;
  const problem = firstProblem(list, codeBound) ?? (codeBound ? routeProblem(list) : null);
  return problem ? `Worker brief format: ${problem}. ${WORKER_BRIEF_FORMAT}` : null;
}

// The notice for a dispatch that is neither code-bound nor an observation:
// a brief that mentions a review but declares no revision. null otherwise.
export function workerBriefNotice(brief: string): string | null {
  if (!REVIEW_WORD.test(brief) || declaresRevision(brief)) return null;
  return `Worker brief revision: the brief mentions a review but names no revision:. ${WORKER_BRIEF_REVISION}`;
}
