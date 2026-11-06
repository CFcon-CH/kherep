// Issue #833. Does a shell command open an issue or a pull request without a
// module label? module-label-guard asks this before a Bash or PowerShell call.
//
// labelIntents() is the pure part: the token walk of command-walk.mts, narrowed
// to the create form of `gh issue|pr` and its flags. ruleFor() reads the rule a repository
// committed to .github/module-labels.json; a repository without that file has no
// rule. judge() compares the two. File system only: no process is started, no
// repository is asked anything.
import fs from "node:fs";
import path from "node:path";

import { ASSIGNMENT, commandName, commandSegments, resolveDir, type Segment } from "./command-walk.mts";

export interface LabelIntent {
  dir: string;
  verb: "issue" | "pr";
  labels: string[];
  // The value of -R/--repo as written, else of a GH_REPO visible in the segment.
  repo?: string | undefined;
  // The browser form cannot be judged, and help creates nothing.
  web: boolean;
  help: boolean;
}

export type Rule = { kind: "none" } | { kind: "invalid"; file: string; defect: string }
  | { kind: "rule"; file: string; repository: string; labels: string[] };

export type Judgement = { action: "pass" } | { action: "block"; message: string };

// The escape marker. Inline it must sit among the assignments that start a
// segment; the PowerShell spelling is a segment of its own and covers the rest
// of the command. Neither is ever read from the environment.
export const MARKER = "KHEREP_MODULE_LABEL=none";
const POWERSHELL_MARKER = /^\$env:KHEREP_MODULE_LABEL=none$/i;
const RULE_FILE = ".github/module-labels.json";

const NO_RULE: Rule = { kind: "none" };
const PASS: Judgement = { action: "pass" };

// The options of `gh issue create` and `gh pr create` that take a value (gh
// 2.100.0, `--help` of both). Their value is data: `--body "--web"` is no --web,
// and `gh -R create issue list` is no create.
const SHORT_VALUE = new Map([["a", "assignee"], ["b", "body"], ["B", "base"], ["F", "body-file"], ["H", "head"], ["l", "label"],
  ["m", "milestone"], ["p", "project"], ["r", "reviewer"], ["R", "repo"], ["T", "template"], ["t", "title"]]);
const LONG_VALUE = new Set([...SHORT_VALUE.values(), "attach", "blocked-by", "blocking", "parent", "recover", "type"]);

const CREATE_ACTIONS = new Set(["create", "new"]);

type Flags = Pick<LabelIntent, "labels" | "repo" | "web" | "help"> & { positionals: string[] };

// A segment after the wrappers this guard looks through.
type Call = Pick<Segment, "name" | "args" | "dir" | "assignments">;

function setValue(flags: Flags, name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (name === "repo") flags.repo = value;
  if (name === "label") flags.labels.push(...value.split(",").map((label) => label.trim()).filter(Boolean));
}

function readLong(arg: string, rest: string[], flags: Flags): void {
  const equals = arg.indexOf("=");
  const name = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
  const inline = equals < 0 ? undefined : arg.slice(equals + 1);
  if (name === "web") flags.web = inline !== "false";
  else if (name === "help") flags.help = inline !== "false";
  else if (LONG_VALUE.has(name)) setValue(flags, name, inline ?? rest.shift());
}

// A short cluster: -wl x is -w -l x. The first letter that takes a value takes
// what follows it, -lx and -l=x alike, or else the next argument.
function readShort(arg: string, rest: string[], flags: Flags): void {
  for (const [index, letter] of [...arg.slice(1)].entries()) {
    const name = SHORT_VALUE.get(letter);
    if (name) {
      const tail = arg.slice(index + 2);
      setValue(flags, name, tail ? tail.replace(/^=/, "") : rest.shift());
      return;
    }
    if (letter === "w") flags.web = true;
    if (letter === "h") flags.help = true;
  }
}

function readFlags(args: string[]): Flags {
  const flags: Flags = { labels: [], web: false, help: false, positionals: [] };
  const rest = [...args];
  while (rest.length && rest[0] !== "--") {
    const arg = rest.shift()!;
    if (arg.startsWith("--")) readLong(arg, rest, flags);
    else if (arg.startsWith("-") && arg.length > 1) readShort(arg, rest, flags);
    else flags.positionals.push(arg);
  }
  return flags;
}

// `env [option|NAME=value]... <command>`. -C moves the directory the rule is read from.
function throughEnv(call: Call): Call {
  const rest = [...call.args];
  const assignments = [...call.assignments];
  let dir = call.dir;
  while (rest[0] !== undefined && (rest[0].startsWith("-") || ASSIGNMENT.test(rest[0]))) {
    const arg = rest.shift()!;
    if (ASSIGNMENT.test(arg)) assignments.push(arg);
    else if (arg.startsWith("--chdir=")) dir = resolveDir(dir, arg.slice("--chdir=".length));
    else if (arg === "-C" || arg === "--chdir") dir = resolveDir(dir, rest.shift() ?? "");
    else if (arg === "-u" || arg === "--unset" || arg === "-P") rest.shift();
  }
  return { name: commandName(rest[0]), args: rest.slice(1), dir, assignments };
}

// `command [-p] <command>`. -v and -V only ask where a command is and run nothing.
function throughCommand(call: Call): Call {
  const rest = [...call.args];
  while (rest[0]?.startsWith("-")) {
    if (/^-[A-Za-z]*[vV]/.test(rest.shift()!)) return { ...call, name: "", args: [] };
  }
  return { ...call, name: commandName(rest[0]), args: rest.slice(1) };
}

function unwrapped(segment: Segment): Call {
  let call: Call = segment;
  while (call.name === "env" || call.name === "command") call = call.name === "env" ? throughEnv(call) : throughCommand(call);
  return call;
}

// gh reads GH_REPO only when no -R is given. An empty value selects nothing.
const visibleRepo = (assignments: string[]): string | undefined =>
  assignments.findLast((assignment) => assignment.startsWith("GH_REPO="))?.slice("GH_REPO=".length) || undefined;

// Every invocation of the create form of <command>, in any spelling that reaches
// it: `create` or its alias `new`, flags before the subcommand, through `env` or
// `command`. Each comes with the directory it runs in; segments carrying the
// escape marker are left out. The walk ends a segment at a newline, so a line
// continuation (bash `\`, PowerShell backtick) joins its lines first; a multi-line
// gh call is one command.
export function labelIntents(command: string, cwd: string): LabelIntent[] {
  const joined = command.replace(/[\\`]\r?\n/g, " ");
  return commandSegments(joined, cwd, { inline: MARKER, powershell: POWERSHELL_MARKER }).flatMap((segment) => {
    const call = unwrapped(segment);
    if (call.name !== "gh" || segment.escaped || call.assignments.includes(MARKER)) return [];
    const { positionals: [verb, action], ...flags } = readFlags(call.args);
    if ((verb !== "issue" && verb !== "pr") || !CREATE_ACTIONS.has(action ?? "")) return [];
    return [{ dir: call.dir, verb, ...flags, repo: flags.repo ?? visibleRepo(call.assignments) }];
  });
}

// The first directory at or above <dir> holding .git: a directory, or the file of
// a linked worktree.
function repositoryRoot(dir: string): string | null {
  let current = dir;
  while (!fs.existsSync(path.join(current, ".git"))) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function shapeDefect(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not a JSON object";
  const { version, repository, labels } = value as Record<string, unknown>;
  if (version !== 1) return "version is not 1";
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) return "repository is not owner/name";
  if (!Array.isArray(labels) || !labels.length) return "labels is not a non-empty list";
  return labels.every((label) => typeof label === "string" && label.trim()) ? null : "labels holds something other than a label name";
}

function readRule(file: string): Rule {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? NO_RULE : { kind: "invalid", file, defect: `unreadable (${code})` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", file, defect: "not valid JSON" };
  }
  const defect = shapeDefect(value);
  if (defect) return { kind: "invalid", file, defect };
  const { repository, labels } = value as { repository: string; labels: string[] };
  return { kind: "rule", file, repository, labels };
}

// --repo is [HOST/]OWNER/REPO; the file names OWNER/REPO.
const slugOf = (repo: string): string => repo.split("/").slice(-2).join("/").toLowerCase();

// The rule of the repository <dir> lies in. With <repo> it applies only when the
// file names that repository; a file that cannot be read names none and stays a defect.
export function ruleFor(dir: string, repo?: string): Rule {
  const root = repositoryRoot(dir);
  if (root === null) return NO_RULE;
  const rule = readRule(path.join(root, RULE_FILE));
  return rule.kind === "rule" && repo !== undefined && slugOf(repo) !== slugOf(rule.repository) ? NO_RULE : rule;
}

export function judge(intent: LabelIntent, rule: Rule): Judgement {
  if (intent.web || intent.help || rule.kind === "none") return PASS;
  if (rule.kind === "invalid") return { action: "block", message: `${rule.file} cannot be used: ${rule.defect}` };
  if (intent.labels.some((label) => rule.labels.includes(label))) return PASS;
  return { action: "block", message: `gh ${intent.verb} create has no module label from ${rule.file}: ${rule.labels.join(", ")}` };
}
