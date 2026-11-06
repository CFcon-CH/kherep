// Issue #325. The shell token walk shared by the main-checkout guard and the
// attribution hook: which commands a Bash or PowerShell line runs, and in which
// directory. It follows `cd` and its PowerShell aliases, re-enters `bash -c` and
// `pwsh -Command` scripts, and treats heredoc and here-string bodies as data.
// Callers judge the segments; this module never asks git anything.
import { joinPathLike, normalizePathLike } from "./workspace-scope.mts";

// One command of the line: its name (lower case, without a directory or .exe),
// its arguments, the directory it runs in and its text from the name on.
// escaped: the caller's escape marker covers it. assignments: the NAME=value
// tokens in front of the name, as written.
export interface Segment {
  name: string;
  args: string[];
  dir: string;
  text: string;
  escaped: boolean;
  assignments: string[];
}

// An inline marker sits among the assignments that start a segment; the
// PowerShell spelling is a segment of its own and covers the rest of the line.
export interface EscapeMarker {
  inline: string;
  powershell: RegExp;
}

const SEPARATORS = new Set([";", "&", "|", "\n", "\r", "(", ")"]);
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const CHANGE_DIR = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "pwsh", "powershell"]);
export const SHELL_SCRIPT_FLAG = /^-(?:[A-Za-z]*c|command)$/i;
const GIT_VALUE_OPTIONS = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

// Heredoc and PowerShell here-string bodies are data, not commands: a commit
// message that documents `git switch` must not read as one.
function withoutHeredocs(command: string): string {
  const kept: string[] = [];
  let end: string | null = null;
  for (const line of command.split("\n")) {
    if (end !== null) {
      // A here-string closes with '@ or "@ at the line start, a heredoc with its word alone.
      if (end.endsWith("@") ? line.startsWith(end) : line.trim() === end) end = null;
      else continue;
    }
    kept.push(line);
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    const hereString = /@(['"])\s*$/.exec(line);
    if (heredoc) end = heredoc[2]!;
    else if (hereString) end = `${hereString[1]}@`;
  }
  return kept.join("\n");
}

// Splits on unquoted separators and whitespace in one pass. Quotes group and
// are dropped; there is no escape processing, so a Windows path keeps its
// backslashes. An unquoted `#` at a word start comments out the line.
function segments(command: string): string[][] {
  const out: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote = "";
  let comment = false;
  const endToken = (): void => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length) out.push(tokens);
    tokens = [];
  };
  for (const ch of command) {
    if (comment) {
      if (ch === "\n") { comment = false; endSegment(); }
    } else if (quote) {
      if (ch === quote) quote = "";
      else token += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === "#" && !inToken) {
      comment = true;
    } else if (SEPARATORS.has(ch)) {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      token += ch;
      inToken = true;
    }
  }
  endSegment();
  return out;
}

// Git for Windows does not read the /d/... form a Git Bash `cd` produces.
export function hostPath(value: string): string {
  const normalized = normalizePathLike(value);
  if (process.platform !== "win32") return normalized;
  return normalized.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

// <dir> is already normalized, so only a target with `..` needs the whole path
// normalized again, and a path past any real length limit stops growing: a run
// of `cd x;` stays linear.
export function resolveDir(dir: string, value: string): string {
  const target = normalizePathLike(value);
  if (/^(?:[A-Za-z]:\/|\/)/.test(target)) return hostPath(target);
  if (!target) return dir;
  const resolved = target.split("/").includes("..") ? normalizePathLike(joinPathLike(dir, target)) : `${dir}/${target}`;
  return resolved.length > 4096 ? dir : resolved;
}

export function commandName(token: string | undefined): string {
  return (token ?? "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
}

// The git subcommand after the global options, and the directory a -C names.
export function gitSubcommand(args: string[], dir: string): { verb?: string; rest: string[]; dir: string } {
  let k = 0;
  for (; k < args.length && args[k]!.startsWith("-"); k++) {
    if (args[k] === "-C" && args[k + 1] !== undefined) dir = resolveDir(dir, args[++k]!);
    else if (GIT_VALUE_OPTIONS.has(args[k]!)) k++;
  }
  return { verb: args[k], rest: args.slice(k + 1), dir };
}

// Every command <command> runs, in order, except the `cd`s and shell wrappers
// the walk itself follows.
export function commandSegments(command: string, cwd: string, marker?: EscapeMarker, escapedFromStart = false): Segment[] {
  const found: Segment[] = [];
  let dir = hostPath(cwd);
  let escapedFromHere = escapedFromStart;
  for (const tokens of segments(withoutHeredocs(command))) {
    if (marker?.powershell.test(tokens.join(""))) {
      escapedFromHere = true;
      continue;
    }
    let i = 0;
    let escaped = escapedFromHere;
    for (; i < tokens.length && ASSIGNMENT.test(tokens[i]!); i++) if (tokens[i] === marker?.inline) escaped = true;
    const name = commandName(tokens[i]);
    const args = tokens.slice(i + 1);
    if (CHANGE_DIR.has(name)) {
      const target = args.find((arg) => !arg.startsWith("-"));
      if (target) dir = resolveDir(dir, target);
    } else if (SHELLS.has(name)) {
      const flag = args.findIndex((arg) => SHELL_SCRIPT_FLAG.test(arg));
      if (flag >= 0 && args[flag + 1] !== undefined) found.push(...commandSegments(args[flag + 1]!, dir, marker, escaped));
    } else if (name) {
      found.push({ name, args, dir, text: tokens.slice(i).join(" "), escaped, assignments: tokens.slice(0, i) });
    }
  }
  return found;
}
