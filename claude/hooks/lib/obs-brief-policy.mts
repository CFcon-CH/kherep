// Issue #331. The observation agent labels a finding evidence-confirmed only
// when the brief marks it `measured:` with the command and the deciding output
// excerpt (claude/agents/claude-obs.md, codex/agents/codex-obs.md). Before, only
// the Stop hooks told a session that format, so a session that dispatched the
// agent on its own never saw it. Both dispatch guards apply this check, which
// puts the format where the brief is written.
//
// A finding starts at a lowercase `measured:` or `relayed:` marker at the start
// of a line, optionally after whitespace and a list bullet (-, *) or a list
// number (1. or 1)), and runs to the next marker or the end of the brief. Text
// before the first marker, such as a summary or a "Scope: <node>" line, is no
// finding. Pure: no I/O, and a reason never quotes the brief.

// The three observation hook reasons state this sentence verbatim
// (bootstrap/observation-agent-contract.test.mts holds them together).
export const OBS_BRIEF_FORMAT =
  "Mark each finding at the start of its own line as measured: `<command>` -> <deciding output excerpt>, or relayed: <source>.";
// Claude's Stop hook accepts this opt-out (claude/hooks/observation-stop.mts).
export const CLAUDE_NOTHING_TO_FILE =
  "If nothing is worth filing, dispatch nothing and end the turn with [obs: none – <reason>].";
// Codex has no opt-out marker; an empty codex-obs result means zero writes.
export const CODEX_NOTHING_TO_FILE =
  "If nothing is worth filing, say so in one relayed: line; an empty result is valid.";

const MARKER = /^[ \t]*(?:(?:[-*]|\d+[.)])[ \t]*)?(measured|relayed):/gm;

interface CodeSpan { start: number; end: number; content: string }

// A CommonMark code span: a run of backticks, content, the same run again. The
// first span in reading order; an opening run may be used from any of its
// backticks, so the longest usable part of the earliest run wins.
function codeSpan(text: string): CodeSpan | null {
  const runs: { at: number; length: number }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "`") continue;
    const at = i;
    while (text[i + 1] === "`") i += 1;
    runs.push({ at, length: i - at + 1 });
  }
  const nearest = new Map<number, number>(); // run length -> the nearest run of that length to the right
  let found: CodeSpan | null = null;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const open = runs[i];
    for (let length = open.length; length >= 1; length -= 1) {
      const close = nearest.get(length);
      if (close === undefined) continue;
      found = { start: open.at + open.length - length, end: runs[close].at + length, content: text.slice(open.at + open.length, runs[close].at) };
      break;
    }
    nearest.set(open.length, i);
  }
  return found;
}

interface Finding {
  kind: string;
  text: string;
}

function findings(brief: string): Finding[] {
  const marks = [...brief.matchAll(MARKER)];
  return marks.map((mark, index) => ({
    kind: mark[1],
    text: brief.slice(mark.index + mark[0].length, marks[index + 1]?.index ?? brief.length),
  }));
}

function measuredIssue(text: string): string | null {
  const span = codeSpan(text);
  if (!span || !span.content.trim()) return "has no command in an inline code span";
  const rest = text.slice(span.end);
  const arrow = rest.indexOf("->");
  if (arrow < 0) return "has no -> after the command";
  return rest.slice(arrow + 2).trim() ? null : "has no deciding output excerpt after ->";
}

function findingIssue({ kind, text }: Finding): string | null {
  if (kind === "measured") return measuredIssue(text);
  return text.trim() ? null : "names no source";
}

function firstProblem(brief: string): string | null {
  const list = findings(brief);
  if (!list.length) return "the brief marks no finding";
  for (const [index, finding] of list.entries()) {
    const issue = findingIssue(finding);
    if (issue) return `finding ${index + 1} (${finding.kind}:) ${issue}`;
  }
  return null;
}

// null when the brief is well-formed, else the deny reason: the first problem,
// the format, and what to do when nothing is worth filing.
export function observationBriefIssue(brief: string, nothingToFile: string = CLAUDE_NOTHING_TO_FILE): string | null {
  const problem = firstProblem(brief);
  return problem ? `Observation brief format: ${problem}. ${OBS_BRIEF_FORMAT} ${nothingToFile}` : null;
}

// Issue #505. A finding about repository code is `confirmed` only when it
// names each repository as <name>@<full commit sha>, measured on a clean tree.
// The token `code` as the first word after `measured:` declares it; the
// binding tokens follow, before the command's code span. This is a report,
// never a deny: the notice names positions only and quotes nothing.
export const OBS_BRIEF_REVISION =
  "A finding about repository code starts with code after measured: and names each repository as <name>@<full commit sha> before the command, each followed by -- and the repo-relative paths the finding rests on.";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const SHA = /^[0-9a-f]{40}$/;
const NO_REPOSITORY = "is code-bound but names no repository";
const NO_FULL_SHA = "names a repository without a full 40-hex commit SHA";
const DIRTY_TREE = "was measured on a dirty tree";
const MALFORMED = "has a malformed repository or revision";
const BOUND_ADVICE = "The observation agent files each as assumed: no exact binding to the measured code. "
  + "Give <name>@<sha> after `code`, the SHA from `git rev-parse HEAD` of the checkout the command ran in, "
  + "add -dirty only when that tree had uncommitted changes, or drop `code` when the finding is not about repository code.";
// Issue #693. Each binding may be followed by `--` and the repo-relative paths the finding rests on, the
// path grammar of modules/atl-jira-brokers/confluence-claim-text.mts (copied: this hook is installed alone).
const PATH = /^(?!-)(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)*$/;
const PATH_LIST = "has a path list that is not repo-relative forward-slash paths";
const UNSCOPED = "binds a repository without naming the paths the finding rests on";
const PATHS_ADVICE = "Paths never change the evidence label; without a valid list the Revision line is unscoped and never checked for staleness. "
  + "After each <name>@<sha> give -- and 1 to 16 distinct repo-relative paths with forward slashes, no glob, no .., "
  + "unless the finding rests on the whole repository.";
const UNMARKED = "names no repository and commit SHA";
const UNMARKED_PARTIAL = "has no complete binding of all named repositories";
const UNMARKED_ADVICE = "If it is about repository code, tests or a build, the observation agent files it as assumed; "
  + "add `code <name>@<sha>` after measured:. A finding that is not about repository code is unchanged.";

// null for a complete <name>@<sha>, else the clause for that token.
function tokenProblem(token: string): string | null {
  const at = token.indexOf("@");
  const name = at < 0 ? token : token.slice(0, at);
  if (!NAME.test(name)) return MALFORMED;
  if (at < 0) return NO_FULL_SHA;
  const revision = token.slice(at + 1);
  const dirty = revision.endsWith("-dirty");
  if (!SHA.test(dirty ? revision.slice(0, -"-dirty".length) : revision)) return NO_FULL_SHA;
  return dirty ? DIRTY_TREE : null;
}

// The words between `measured:` and the command's code span: the only place a
// finding declares `code` and its binding (not the excerpt, not the preamble).
// A well-formed measured: finding always has the span (measuredIssue).
function prefixWords(text: string): string[] {
  return text.slice(0, codeSpan(text)?.start ?? 0).split(/\s+/).filter(Boolean);
}

function pathListOk(paths: string[]): boolean {
  return paths.length >= 1 && paths.length <= 16
    && new Set(paths).size === paths.length && paths.every((p) => p.length <= 200 && PATH.test(p));
}

// The words after `code`: binding groups, each a <name>@<sha> word, optionally `--` and its paths. The first
// binding problem in order wins (#505); else a path-list problem; else a clean binding without paths.
function codeProblem(tokens: string[]): { bound?: string; paths?: string } {
  if (!tokens.length) return { bound: NO_REPOSITORY };
  let binding: "none" | "clean" | "flawed" = "none", list: string[] | null = null, pathIssue = false, unscoped = false;
  let boundIssue: string | null = null;
  const close = () => {
    if (binding === "clean" && list === null) unscoped = true;
    if (list !== null && !pathListOk(list)) pathIssue = true;
  };
  for (const word of tokens) {
    // A word before any binding is a binding token as in #505, unless a stray -- opened an orphan list.
    if (word.includes("@") || (binding === "none" && list === null && word !== "--")) {
      close();
      const problem = tokenProblem(word);
      boundIssue ??= problem;
      binding = problem ? "flawed" : "clean";
      list = null;
    } else if (word === "--") {
      if (binding === "none" || list !== null) pathIssue = true;
      list ??= [];
    } else if (list !== null) list.push(word);
    else pathIssue = true;
  }
  close();
  if (binding === "none") return { bound: NO_REPOSITORY };
  if (boundIssue) return { bound: boundIssue };
  if (pathIssue) return { paths: PATH_LIST };
  if (unscoped) return { paths: UNSCOPED };
  return {};
}

// null when every measured: finding is bound and scoped or plainly not declared, else one
// notice. Computed only for a brief observationBriefIssue accepts.
export function observationBriefNotice(brief: string): string | null {
  if (firstProblem(brief)) return null;
  const bound: string[] = [];
  const scoped: string[] = [];
  const unmarked: string[] = [];
  for (const [index, finding] of findings(brief).entries()) {
    if (finding.kind !== "measured") continue;
    const position = `finding ${index + 1} (measured:)`;
    const words = prefixWords(finding.text);
    if (words[0] !== "code") {
      // Without the declaration, a word with @ is a named binding: the finding
      // is silent only when it names one and every one it names is complete.
      const named = words.filter((word) => word.includes("@"));
      if (!named.length) unmarked.push(`${position} ${UNMARKED}`);
      else if (named.some((word) => tokenProblem(word) !== null)) unmarked.push(`${position} ${UNMARKED_PARTIAL}`);
      continue;
    }
    const problem = codeProblem(words.slice(1));
    if (problem.bound) bound.push(`${position} ${problem.bound}`);
    else if (problem.paths) scoped.push(`${position} ${problem.paths}`);
  }
  const parts = [
    bound.length ? `${bound.join("; ")}. ${BOUND_ADVICE}` : "",
    scoped.length ? `${scoped.join("; ")}. ${PATHS_ADVICE}` : "",
    unmarked.length ? `${unmarked.join("; ")}. ${UNMARKED_ADVICE}` : "",
  ].filter(Boolean);
  return parts.length ? `Observation brief revision: ${parts.join(" Also, ")}` : null;
}
