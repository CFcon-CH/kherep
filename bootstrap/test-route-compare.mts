// What the Windows test route (issue #832) reads from other programs and from its environment: the
// suite definitions in package.json, TAP and tsc names, the child environment, the paths it must
// stay out of. The rules that conclude from these are in bootstrap/test-route-proof.mts.

import fs from "node:fs";
import path from "node:path";

import { type ParsedTap } from "../codex/scripts/codex-run-tap.mts";
import { errorCode } from "./shape.mts";

export interface Suite { name: string; flags: string[]; patterns: string[] }
export interface Failing { name: string; file: string | null }
export interface RunResult { status: number | null; signal: string | null; error: string | null; killed: boolean }

const SUFFIX = "/*.test.mts";
const PATTERN = /^"([A-Za-z0-9_./-]+\/\*\.test\.mts)"$/;
// Only flags that select nothing: a name pattern or a shard would change what a suite proves.
const FLAG = /^--test-(?:concurrency=\d+|timeout=\d+|force-exit)$/;

function suiteOf(name: string, script: string): Suite {
  const notUnderstood = new Error(`script test:${name} not understood: ${script}`);
  const [node, test, ...tokens] = script.trim().split(/\s+/);
  if (node !== "node" || test !== "--test") throw notUnderstood;
  const suite: Suite = { name, flags: [], patterns: [] };
  for (const token of tokens) {
    const pattern = PATTERN.exec(token)?.[1];
    if (FLAG.test(token)) suite.flags.push(token);
    else if (pattern && !pattern.includes("..") && !pattern.startsWith("/")) suite.patterns.push(pattern);
    else throw notUnderstood;
  }
  if (!suite.patterns.length) throw notUnderstood;
  return suite;
}

// A suite is a test:<name> script of the form `node --test [flags] "<dir>/*.test.mts"...`, byte-equal
// in the base and the candidate. Any other form is refused, as in the run guard.
export function suitesFromPackage(baseText: string, candidateText: string, names: string[]): Suite[] {
  const scripts = (text: string) => (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
  const [base, candidate] = [scripts(baseText), scripts(candidateText)];
  return names.map((name) => {
    const [before, after] = [base[`test:${name}`], candidate[`test:${name}`]];
    if (before === undefined && after === undefined) throw new Error(`package.json has no script test:${name}`);
    if (before !== after) throw new Error(`suite ${name}: definition differs\n  base:      ${String(before)}\n  candidate: ${String(after)}`);
    if (typeof after !== "string") throw new Error(`script test:${name} not understood: ${String(after)}`);
    return suiteOf(name, after);
  });
}

// The files a pattern selects, as in codex/scripts/codex-run-guard.mts.
export function selectedFiles(root: string, pattern: string): string[] {
  try {
    return fs.readdirSync(path.join(root, pattern.slice(0, -SUFFIX.length)), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mts"))
      .map((entry) => entry.name);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function relativeFile(location: string, root: string): string {
  const file = location.replace(/:\d+:\d+$/, "").replaceAll("\\", "/");
  const prefix = `${root.replaceAll("\\", "/").replace(/\/$/, "")}/`;
  return file.toLowerCase().startsWith(prefix.toLowerCase()) ? file.slice(prefix.length) : file;
}

// Every test record that is not ok, with or without a directive, plus suites that failed on their
// own: a describe block that throws while it is defined hides its tests, and Node counts it in no
// summary field. A suite that failed only through its subtests adds nothing.
export function failingNames(parsed: ParsedTap, root: string): Failing[] {
  return parsed.records
    .filter((record) => !record.ok && (record.type === "test" || record.failureType !== "subtestsFailed"))
    .map((record) => ({ name: record.name, file: record.location === null ? null : relativeFile(record.location, root) }));
}

export function passingNames(parsed: ParsedTap): string[] {
  return parsed.records.filter((record) => record.type === "test" && record.ok && !record.directive).map((record) => record.name);
}

// `<file> <code> <first message line>`: an error that moves keeps its name.
export function tscNames(text: string): string[] {
  return [...text.matchAll(/^(?:(.+?)\(\d+,\d+\): )?error (TS\d+): (.*)$/gm)]
    .map(([, file, code, message]) => `${file ?? ""} ${code} ${message}`.trim());
}

// A copy without what would steer a child: GIT_DIR moved the candidate's HEAD, npm_* points the base
// run at the candidate, a node --test child that inherits NODE_TEST_CONTEXT writes no TAP (see
// codex-run-guard.mts), and NODE_OPTIONS can select tests in both trees alike.
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:GIT_|npm_|NODE_TEST_CONTEXT$|NODE_OPTIONS$)/i.test(key)));
}

// Git for Windows, by the fixed list of claude/hooks/drift-check-nudge.mts.
export function gitBashDir(localAppData: string | undefined, exists: (file: string) => boolean): string | null {
  const dirs = ["C:/Program Files/Git/bin", "C:/Program Files (x86)/Git/bin"];
  if (localAppData) dirs.push(`${localAppData.replaceAll("\\", "/")}/Programs/Git/bin`);
  return dirs.find((dir) => exists(`${dir}/bash.exe`)) ?? null;
}

// Under the key the environment already has: Windows spells it Path, and a second PATH key is
// not what the child would read.
export function withPathFirst(env: NodeJS.ProcessEnv, dir: string, platform: string): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const key = Object.keys(env).find((name) => (windows ? name.toUpperCase() : name) === "PATH") ?? "PATH";
  return { ...env, [key]: env[key] ? `${dir}${windows ? ";" : ":"}${env[key]}` : dir };
}

// Any of these means the count would come from the Codex sandbox or a Codex shell, which is what
// the issue rules out. CODEX_THREAD_ID alone does not prove a sandbox, and it does not need to.
export const SANDBOX_MARKERS = ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID"];

export function sandboxMarkers(env: NodeJS.ProcessEnv): string[] {
  return SANDBOX_MARKERS.filter((marker) => env[marker] !== undefined);
}

type Realpath = (file: string) => string;

// A path that does not exist yet resolves through its nearest existing ancestor. Only absence walks
// up: an access error cannot show where the path leads, so it refuses.
function realPath(target: string, realpath: Realpath): string {
  const rest: string[] = [];
  for (let at = path.resolve(target); ; at = path.dirname(at)) {
    try { return path.join(realpath(at), ...rest); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) throw error;
      if (path.dirname(at) === at) return path.join(at, ...rest);
      rest.unshift(path.basename(at));
    }
  }
}

// Real paths on both sides, so junctions, 8.3 names and case cannot hide the relation.
export function insideRoot(dir: string, root: string, realpath: Realpath = fs.realpathSync.native): boolean {
  const relative = path.relative(realPath(root, realpath), realPath(dir, realpath));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Node 22+ refuses npm.cmd without a shell and the route uses no shell, so npm runs as a script: the
// one that started the route if there is one, else the layouts beside the node executable.
export function npmCliPath(execPath: string, npmExecpath: string | undefined, exists: (file: string) => boolean): string | null {
  const dir = path.dirname(execPath);
  const started = npmExecpath?.endsWith("npm-cli.js") ? [npmExecpath] : [];
  return [...started, path.join(dir, "node_modules/npm/bin/npm-cli.js"), path.join(dir, "../lib/node_modules/npm/bin/npm-cli.js")].find(exists) ?? null;
}

interface CpuSample { times: { user: number; nice: number; sys: number; idle: number; irq: number } }

export function cpuBusyPct(before: CpuSample[], after: CpuSample[]): number {
  const total = ({ times }: CpuSample) => times.user + times.nice + times.sys + times.idle + times.irq;
  const span = after.reduce((sum, cpu, index) => sum + total(cpu) - total(before[index]), 0);
  const idle = after.reduce((sum, cpu, index) => sum + cpu.times.idle - before[index].times.idle, 0);
  return span > 0 ? Math.round((1 - idle / span) * 100) : 0;
}
