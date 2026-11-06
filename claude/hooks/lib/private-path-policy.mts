// OP-1137. Ob ein Tool-Aufruf auf eine private Wurzel zeigt: das Absuchen der
// Strings, die Zerlegung einer Shell-Zeile und der Vergleich kanonischer Pfade.
// WELCHE Verzeichnisse als Wurzel gelten, steht in private-path-rules.mts:
// getrennt, weil die getypte Fassung sonst über der 250-Zeilen-Grenze aus
// CLAUDE.md läge. Verhalten unverändert.

import {
  configuredWorkspace,
  isWithinPath,
  joinPathLike,
  normalizePathLike,
  workspaceForPayload,
  type EnvLike,
  type ScopePayload,
} from "./workspace-scope.mts";
import { canonicalPathForms, canonicalPathLike } from "./real-path-policy.mts";
import { artifactRoots, credentialsRoots, expandHome, type RootContext } from "./private-path-rules.mts";
import { CHANGE_DIR, SHELL_SCRIPT_FLAG, SHELLS } from "./command-walk.mts";

// Der Tool-Input, so wie ein Hook ihn weiterreicht. Gelesen wird gezielt nur
// command; jedes andere Feld erreicht die Prüfung über allStrings.
export interface PolicyInput {
  command?: unknown;
  [key: string]: unknown;
}

function allStrings(value: unknown, out: string[] = [], seen = new Set<object>()): string[] {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    Object.values(value).forEach((child) => allStrings(child, out, seen));
  }
  return out;
}

function containsBoundedPath(text: unknown, target: unknown): boolean {
  const haystack = String(text || "").replace(/\\/g, "/").toLowerCase();
  const needle = normalizePathLike(target).toLowerCase();
  if (!needle) return false;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const before = at === 0 || /[\s"'`=(:,]/.test(haystack[at - 1]);
    const end = at + needle.length;
    const after = end === haystack.length || /[\/\s"'`*?;|&)<>,]/.test(haystack[end]);
    if (before && after) return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (word) { words.push(word); word = ""; }
    } else word += char;
  }
  if (quote) return [];
  if (word) words.push(word);
  return words;
}

function expandKnownShellValues(command: unknown, payload: ScopePayload, env: EnvLike = process.env): string {
  const workspace = workspaceForPayload(payload, env) || configuredWorkspace(env);
  const values = {
    KHEREP_WORKSPACE: Object.hasOwn(env, "KHEREP_WORKSPACE") ? env.KHEREP_WORKSPACE : workspace,
    KHEREP_CREDENTIALS_ROOT: env.KHEREP_CREDENTIALS_ROOT,
    KHEREP_LOCAL_OUTPUT_ROOT: env.KHEREP_LOCAL_OUTPUT_ROOT,
    HOME: env.HOME || env.USERPROFILE,
    USERPROFILE: env.USERPROFILE || env.HOME,
  };
  let expanded = String(command || "");
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    const pattern = new RegExp(`\\$\\{${name}\\}|\\$env:${name}\\b|\\$${name}\\b|%${name}%`, "gi");
    expanded = expanded.replace(pattern, String(value));
  }
  return expanded;
}

function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let segment = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      segment += char;
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") { quote = char; segment += char; }
    else if (["&&", "||"].includes(command.slice(i, i + 2))) {
      if (segment.trim()) segments.push(segment.trim());
      segment = "";
      i++;
    } else if ([";", "\n", "\r", "|"].includes(char)) {
      if (segment.trim()) segments.push(segment.trim());
      segment = "";
    } else segment += char;
  }
  if (segment.trim()) segments.push(segment.trim());
  return segments;
}

function resolveShellPath(value: unknown, cwd: string): string {
  // Issue #358: a PowerShell parameter can carry its value after a colon.
  let candidate = String(value || "").replace(/^[({]+|(?<![)},])[)},]+$/g, "").replace(/^-[A-Za-z]+:/, "");
  if (candidate.includes("=") && !candidate.startsWith("=")) candidate = candidate.slice(candidate.indexOf("=") + 1);
  if (!candidate || /^-/.test(candidate) || /^[a-z]+:\/\//i.test(candidate)) return "";
  candidate = normalizePathLike(expandHome(candidate));
  if (!candidate) return "";
  return /^(?:[A-Za-z]:\/|\/)/.test(candidate) ? candidate : joinPathLike(cwd, candidate);
}

// Das Verzeichnis, gegen das relative Angaben aufgelöst werden. Die Kette steht
// einmal hier, weil beide Aufrufer denselben Rückfall brauchen.
function payloadCwd(payload: ScopePayload): string {
  return normalizePathLike(payload.cwd || workspaceForPayload(payload) || process.cwd());
}

// Issue #348. <value> or any canonical form of it (8.3 short or long) lies in a root.
function withinRoots(value: string, roots: string[]): boolean {
  return [value, ...canonicalPathForms(value)].some((form) => roots.some((root) => isWithinPath(form, root)));
}

function shellReferencesRoots(command: string, payload: ScopePayload, roots: string[], env: EnvLike, start = payloadCwd(payload)): boolean {
  let cwd = canonicalPathLike(start) || start;
  for (const segment of shellSegments(expandKnownShellValues(command, payload, env))) {
    const words = shellWords(segment);
    if (!words.length) continue;
    if (withinRoots(cwd, roots)) return true;
    const executable = (normalizePathLike(words[0]).split("/").pop() || "").toLowerCase().replace(/\.exe$/, "");
    const isCd = CHANGE_DIR.has(executable);
    // Issue #358: a `bash -c` or `pwsh -Command` script runs in the current
    // directory. Each word that follows a script flag is walked, so `-exec Bypass` cannot hide it.
    const reenters = SHELLS.has(executable) && words.some((word, k) =>
      k > 1 && SHELL_SCRIPT_FLAG.test(words[k - 1]) && shellReferencesRoots(word, payload, roots, env, cwd));
    if (reenters) return true;
    if (isCd) {
      const word = words.slice(1).find((item) => !item.startsWith("-") && item.toLowerCase() !== "/d");
      const unresolved = resolveShellPath(word, cwd);
      const target = canonicalPathLike(unresolved) || unresolved;
      if (target) {
        if (withinRoots(target, roots)) return true;
        cwd = target;
      }
    } else {
      for (const item of words.slice(1)) {
        const unresolved = resolveShellPath(item, cwd);
        const candidate = canonicalPathLike(unresolved) || unresolved;
        if (candidate && withinRoots(candidate, roots)) return true;
      }
    }
  }
  return false;
}

function canonicalCandidates(value: unknown, payload: ScopePayload): string[] {
  const candidates = canonicalPathForms(expandHome(value));
  const cwd = payloadCwd(payload);
  for (const word of shellWords(String(value))) {
    if (!/[\\/]/.test(word)) continue;
    const unresolved = resolveShellPath(word, cwd);
    candidates.push(...canonicalPathForms(unresolved));
  }
  return candidates;
}

function referencesRoots(input: PolicyInput, payload: ScopePayload, context: RootContext, env: EnvLike): boolean {
  const { workspace } = context;
  const roots = context.roots.flatMap((root) => [root, ...canonicalPathForms(root)].filter(Boolean));
  for (const value of allStrings(input)) {
    const normalized = normalizePathLike(value);
    const canonical = canonicalCandidates(value, payload);
    for (const root of roots) {
      if (isWithinPath(normalized, root) || canonical.some((item) => isWithinPath(item, root)) || containsBoundedPath(value, root)) return true;
      if (workspace && isWithinPath(root, workspace)) {
        const relative = normalizePathLike(root).slice(normalizePathLike(workspace).length + 1);
        if (relative && containsBoundedPath(value, relative)) return true;
      }
    }
  }
  return typeof input.command === "string" && shellReferencesRoots(input.command, payload, roots, env);
}

export function referencesArtifact(input: PolicyInput, payload: ScopePayload, env: EnvLike = process.env): boolean {
  return referencesRoots(input, payload, artifactRoots(payload, env), env);
}

export function referencesCredentials(input: PolicyInput, payload: ScopePayload, env: EnvLike = process.env): boolean {
  return referencesRoots(input, payload, credentialsRoots(payload, env), env);
}
