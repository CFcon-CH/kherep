// TAP reader and skip-list helpers for the Codex run guard (issue #550). Pure, no I/O.
//
// Reads the TAP that `node --test --test-reporter=tap` writes, as measured on
// Node 22.18 (CI) and 26.10 (local): one `ok|not ok N - <name>[ # SKIP|TODO
// [<reason>]]` line per test, nested subtests indented by four spaces, a YAML
// block after each record that names its `type`, and a final summary block.
// Anything else throws, so a format change on a new Node is loud, never read
// as "no skips":
// - The summary is the last block of the file: a top-level `1..N`, then
//   `tests, suites, pass, fail, cancelled, skipped, todo, duration_ms` in that
//   order. Test output is echoed into the TAP as `# ...` comments, so an
//   earlier `# tests N` line proves nothing.
// - A record whose YAML block has no `type:` line is malformed.
// Node escapes `\` and `#` in names and reasons; one pass undoes both.

export interface TapRecord {
  name: string;
  ok: boolean;
  depth: number;
  directive: "SKIP" | "TODO" | null;
  reason: string | null;
  type: string;
}
export interface TapSummary {
  tests: number; suites: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number;
}
export interface ParsedTap { summary: TapSummary; plan: number; records: TapRecord[] } // plan: the final `1..N`
export interface SkipEntry { name: string; reason: string | null }

const SUMMARY_KEYS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"] as const;
const SUMMARY_LINES = SUMMARY_KEYS.length + 2; // plan line, the keys, duration_ms
const RECORD = /^((?: {4})*)(ok|not ok) \d+(?: - (.*))?$/;
const DIRECTIVE = /^(.*?) # (SKIP|TODO)(?: (.*))?$/;

function malformed(detail: string): Error {
  return new Error(`malformed TAP: ${detail}`);
}

export function unescapeTap(text: string): string {
  return text.replace(/\\([\\#])/g, "$1");
}

// The summary block and the lines before it.
function readSummary(lines: string[]): { summary: TapSummary; plan: number; body: string[] } {
  const block = lines.slice(-SUMMARY_LINES);
  const plan = /^1\.\.(\d+)$/.exec(block[0] ?? "");
  const duration = /^# duration_ms \d+(?:\.\d+)?$/.test(block[block.length - 1] ?? "");
  if (block.length !== SUMMARY_LINES || !plan || !duration) throw malformed("no summary block at end of file");
  const summary = {} as TapSummary;
  SUMMARY_KEYS.forEach((key, index) => {
    const match = new RegExp(`^# ${key} (\\d+)$`).exec(block[index + 1]);
    if (!match) throw malformed("no summary block at end of file");
    summary[key] = Number(match[1]);
  });
  return { summary, plan: Number(plan[1]), body: lines.slice(0, -SUMMARY_LINES) };
}

// The YAML block that must directly follow the record at `index`: its `type:`
// and the index of its closing `...` line, or null when either is absent.
function yamlBlock(lines: string[], index: number, indent: string): { type: string; end: number } | null {
  if (lines[index + 1] !== `${indent}  ---`) return null;
  const typeLine = new RegExp(`^${indent}  type: '([a-z]+)'$`);
  let type: string | null = null;
  for (let line = index + 2; line < lines.length; line++) {
    if (lines[line] === `${indent}  ...`) return type === null ? null : { type, end: line };
    const match = typeLine.exec(lines[line]);
    if (match) type = match[1];
  }
  return null;
}

export function parseTap(text: string): ParsedTap {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const { summary, plan, body } = readSummary(lines);
  const records: TapRecord[] = [];
  let index = -1;
  while (++index < body.length) {
    const match = RECORD.exec(body[index]);
    if (!match) continue;
    const [, indent, status, rest = ""] = match;
    const directive = DIRECTIVE.exec(rest);
    const name = unescapeTap(directive ? directive[1] : rest);
    const yaml = yamlBlock(body, index, indent);
    if (yaml === null) throw malformed(`record without type: ${name}`);
    records.push({
      name,
      ok: status === "ok",
      depth: indent.length / 4,
      directive: directive ? (directive[2] as "SKIP" | "TODO") : null,
      reason: directive && directive[3] !== undefined ? unescapeTap(directive[3]) : null,
      type: yaml.type,
    });
    index = yaml.end; // a YAML block (an error message, a stack) never yields a record
  }
  return { summary, plan, records };
}

// The skipped tests in TAP order, in the entry shape of codex-run-expected.json.
// Suite records are left out: the guard refuses a skipped suite on its own.
export function observedSkips(parsed: ParsedTap): SkipEntry[] {
  return parsed.records
    .filter((record) => record.directive === "SKIP" && record.type === "test")
    .map((record) => ({ name: record.name, reason: record.reason }));
}

// The one serialiser for skip lists: `print` and the observed block of `check`.
export function formatSkips(entries: SkipEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

// Multiset difference by (name, reason): what `a` has beyond `b`.
function minus(a: SkipEntry[], b: SkipEntry[]): SkipEntry[] {
  const key = (entry: SkipEntry) => JSON.stringify([entry.name, entry.reason]);
  const rest = b.map(key);
  return a.filter((entry) => {
    const at = rest.indexOf(key(entry));
    if (at >= 0) rest.splice(at, 1);
    return at < 0;
  });
}

export function compareSkips(expected: SkipEntry[], observed: SkipEntry[]): { missing: SkipEntry[]; extra: SkipEntry[] } {
  return { missing: minus(expected, observed), extra: minus(observed, expected) };
}

// Node counts (countCompletedTest, the same in 22.18.0, 24.1.0, 24.22.0 and 26.10.0): the plan
// `1..N` counts the depth-0 records of either type; a suite record goes to `suites` only; a test
// record goes to `tests` and to exactly one of skipped (SKIP directive), todo (TODO directive),
// or, without a directive, cancelled or fail (both `not ok`, told apart only by the YAML
// failureType) or pass. `# EXPECTED FAILURE` (24.22+) is deliberately not a directive here: Node
// counts such a record in pass or fail by its ok status, as these rows do. The skipped equation
// is C4; the rows here are the rest, in C4's wording (issue #578).
export function reconcile({ summary, plan, records }: ParsedTap): string[] {
  const tests = records.filter((record) => record.type === "test");
  const count = (pick: (record: TapRecord) => boolean) => tests.filter(pick).length;
  const { fail, cancelled } = summary;
  const rows: [number, string, number, string][] = [
    [tests.length, "test records", summary.tests, `# tests ${summary.tests}`],
    [records.filter((record) => record.type === "suite").length, "suite records", summary.suites, `# suites ${summary.suites}`],
    [count((record) => record.ok && !record.directive), "passing records", summary.pass, `# pass ${summary.pass}`],
    [count((record) => !record.ok && !record.directive), "failing records", fail + cancelled, `# fail ${fail} + # cancelled ${cancelled}`],
    [count((record) => record.directive === "TODO"), "TODO records", summary.todo, `# todo ${summary.todo}`],
    [records.filter((record) => record.depth === 0).length, "top-level records", plan, `1..${plan}`],
  ];
  return rows.filter(([observed, , counted]) => observed !== counted).map(([observed, what, , shown]) => `${observed} ${what} but ${shown}`);
}
