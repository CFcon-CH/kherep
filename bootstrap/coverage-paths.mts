import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function containedFile(root: string, filename: string): string {
  const base = realpathSync(root), lexicalRoot = resolve(root);
  const path = resolve(lexicalRoot, filename);
  const rel = relative(lexicalRoot, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path outside repository");
  const real = realpathSync(path);
  const actual = relative(base, real);
  if (actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual) || !statSync(real).isFile()) throw new Error("symlink escape or non-file");
  return real;
}
function noTraversal(value: string): void {
  if (decodeURIComponent(value).split(/[\\/]/).includes("..") || value.includes("\\") || value.includes("\0")) throw new Error("path traversal");
}
type Range = { startOffset: number; endOffset: number; count: number };
type V8Function = { ranges: Range[]; [key: string]: unknown };
type Script = { url: string; functions: V8Function[]; [key: string]: unknown };
type V8Report = { result: Script[]; "source-map-cache"?: Record<string, unknown>; [key: string]: unknown };
export function relocateV8Report(value: unknown, sourceRoot: string, repositoryRoot: string): { report: V8Report; ignored: number } {
  if (!value || typeof value !== "object" || !Array.isArray((value as V8Report).result)) throw new Error("malformed V8 report");
  const report = value as V8Report;
  let ignored = 0;
  function relocate(url: string): string | null {
    if (!url.startsWith("file:")) return null;
    noTraversal(url);
    const path = fileURLToPath(url); const rel = relative(resolve(sourceRoot), path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).includes("node_modules")) return null;
    if (!/\.(mts|ts|js|mjs|cjs|cts)$/.test(rel)) return null;
    return pathToFileURL(containedFile(repositoryRoot, rel)).href;
  }
  const scripts: Script[] = [];
  for (const script of report.result) {
    if (!script || typeof script.url !== "string" || !Array.isArray(script.functions)) throw new Error("malformed V8 script");
    for (const fn of script.functions) {
      if (!fn || !Array.isArray(fn.ranges) || !fn.ranges.length) throw new Error("malformed V8 function");
      for (const range of fn.ranges) {
        if (![range.startOffset, range.endOffset, range.count].every(Number.isSafeInteger) || range.startOffset < 0 || range.endOffset < range.startOffset || range.count < 0) throw new Error("malformed V8 range");
      }
    }
    const url = relocate(script.url);
    if (url) scripts.push({ ...script, url }); else ignored++;
  }
  const cache = report["source-map-cache"];
  if (cache !== undefined && (!cache || typeof cache !== "object" || Array.isArray(cache))) throw new Error("malformed V8 source-map-cache");
  const relocatedCache: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(cache ?? {})) { const url = relocate(key); if (url) relocatedCache[url] = entry; }
  return { report: { ...report, result: scripts, ...(cache === undefined ? {} : { "source-map-cache": relocatedCache }) }, ignored };
}
export function normalizeLcovPaths(lcov: string, repositoryRoot: string, sourceRoot = repositoryRoot): string {
  return lcov.split("\n").map(line => {
    if (!line.startsWith("SF:")) return line;
    const original = line.slice(3); noTraversal(original);
    const path = containedFile(repositoryRoot, resolve(sourceRoot, original));
    return `SF:${relative(realpathSync(repositoryRoot), path).split(sep).join("/")}`;
  }).join("\n");
}
export function validateLcov(lcov: string, repositoryRoot: string): { files: number; lines: number; hit: number } {
  if (!lcov.trim()) throw new Error("empty LCOV report");
  let files = 0, lines = 0, hit = 0;
  const seen = new Set<string>();
  for (const record of lcov.trim().split("end_of_record")) {
    if (!record.trim()) continue;
    if (!lcov.trimEnd().endsWith("end_of_record")) throw new Error("unterminated LCOV record");
    const fields = record.trim().split("\n"); const sources = fields.filter(line => line.startsWith("SF:"));
    if (sources.length !== 1) throw new Error("malformed LCOV source");
    const source = sources[0].slice(3); noTraversal(source);
    if (isAbsolute(source) || seen.has(source)) throw new Error("absolute or duplicate LCOV source");
    const file = containedFile(repositoryRoot, source);
    const canonical = relative(realpathSync(repositoryRoot), file).split(sep).join("/");
    if (source !== canonical || seen.has(canonical)) throw new Error("noncanonical or duplicate LCOV source");
    seen.add(canonical);
    const content = readFileSync(file, "utf8");
    const bound = content ? content.split("\n").length - Number(content.endsWith("\n")) : 0;
    let localLines = 0, localHit = 0, branchCount = 0, branchHit = 0;
    const daLines = new Set<number>(), branches = new Set<string>();
    const functions: string[] = [], functionHits: string[] = []; let fnHit = 0;
    for (const line of fields) {
      if (line.startsWith("DA:")) {
        const match = /^DA:(\d+),(\d+)(?:,[^,]+)?$/.exec(line);
        if (!match) throw new Error("malformed LCOV DA");
        const n = Number(match[1]), count = Number(match[2]);
        if (!Number.isSafeInteger(count) || n < 1 || n > bound || daLines.has(n)) throw new Error("LCOV line outside source or duplicate");
        daLines.add(n); localLines++; if (count > 0) localHit++;
      } else if (line.startsWith("BRDA:")) {
        const match = /^BRDA:(\d+),([^,]+),([^,]+),(-|\d+)$/.exec(line);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > bound) throw new Error("malformed LCOV branch");
        const key = match.slice(1, 4).join(",");
        if (branches.has(key) || (match[4] !== "-" && !Number.isSafeInteger(Number(match[4])))) throw new Error("duplicate or malformed LCOV branch");
        branches.add(key); branchCount++; if (match[4] !== "-" && Number(match[4]) > 0) branchHit++;
      } else if (line.startsWith("FN:")) {
        const match = /^FN:(\d+),(?:(\d+),)?(.+)$/.exec(line);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > bound || (match[2] && (Number(match[2]) < Number(match[1]) || Number(match[2]) > bound))) throw new Error("malformed LCOV function");
        functions.push(match[3]);
      } else if (line.startsWith("FNDA:")) {
        const match = /^FNDA:(\d+),(.+)$/.exec(line);
        if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("malformed LCOV function hits");
        functionHits.push(match[2]); if (Number(match[1]) > 0) fnHit++;
      } else if (line.startsWith("LF:") || line.startsWith("LH:")) {
        if (!/^(LF|LH):\d+$/.test(line)) throw new Error("malformed LCOV totals");
      } else if (!/^(TN:|SF:|FNF:\d+$|FNH:\d+$|BRF:\d+$|BRH:\d+$)/.test(line)) throw new Error("unknown LCOV record");
    }
    if (!localLines) throw new Error("LCOV source has no line records");
    if (functions.sort(byCodeUnit).join("\0") !== functionHits.sort(byCodeUnit).join("\0")) throw new Error("LCOV function records mismatch");
    for (const [prefix, count] of [["LF", localLines], ["LH", localHit], ["FNF", functions.length], ["FNH", fnHit], ["BRF", branchCount], ["BRH", branchHit]] as const) {
      const totals = fields.filter(line => line.startsWith(`${prefix}:`));
      if (totals.length > 1 || (totals.length === 1 && Number(totals[0].slice(prefix.length + 1)) !== count)) throw new Error("LCOV totals mismatch");
    }
    files++; lines += localLines; hit += localHit;
  }
  if (!files || !hit) throw new Error("LCOV has no actual hit data");
  return { files, lines, hit };
}
