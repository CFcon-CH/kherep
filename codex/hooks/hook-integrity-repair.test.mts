// Issue #965. hook-integrity-repair.mts through its exports, with the libs hook-integrity.mts
// loads from the checkout: the observation snapshot, the measured restore, the journal and the
// source readers. The installed hook end to end is in hook-integrity-trigger.test.mts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test, type TestContext } from "node:test";

import { lib, loadLibs } from "./hook-integrity.mts";
import { entryChecker, journal, observationSource, restore, sourceReaders, type Ctx, type Restored } from "./hook-integrity-repair.mts";
import { COMPUTED, computedImports, sourceOf } from "./hook-integrity-sources.mts";

const FROM = "codex/hooks/hook-integrity-sources.mts";
const sha = (bytes: string | Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

before(async () => { assert.equal(await loadLibs(), null); });

function box(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-repair-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), hooksDir = path.join(root, "home", "hooks"), repo = path.join(root, "repo");
  fs.mkdirSync(path.join(hooksDir, "kherep-maestro"), { recursive: true });
  // A versioned file in the fixture checkout, by its repository path.
  const version = (from: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(repo, from)), { recursive: true }); fs.writeFileSync(path.join(repo, from), text); };
  // The observation snapshot of home: files by repository path, and the manifest of their hashes.
  const snapshot = (files: Record<string, string>, manifest = Object.fromEntries(Object.entries(files).map(([from, text]) => [from, sha(text)]))): void => {
    const dir = path.join(home, "orchestra", "observation-source");
    for (const [from, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, from)), { recursive: true }); fs.writeFileSync(path.join(dir, from), text); }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  };
  return { root, home, hooksDir, repo, version, snapshot, target: path.join(hooksDir, "kherep-maestro", "codex-hook-integrity-sources.mts") };
}

test("observationSource: only the fixed sources, only a regular file with the manifest's hash", (t) => {
  const b = box(t);
  assert.equal(observationSource(b.home, FROM), null, "no snapshot");
  b.snapshot({ [FROM]: "export {};\n" });
  assert.equal(observationSource(b.home, "claude/hooks/commit-guard.mts"), null, "not an observation source");
  assert.equal(observationSource(b.home, FROM)?.toString(), "export {};\n");
  b.snapshot({ [FROM]: "export {};\n" }, { [FROM]: sha("other") });
  assert.throws(() => observationSource(b.home, FROM), { message: "observation-source-unverified" });
  b.snapshot({ [FROM]: "x".repeat(100_001) });
  assert.throws(() => observationSource(b.home, FROM), { message: "observation-source-unverified" }, "over the size bound");
});

test("restore: refused without a source, from an unreadable or empty one, and outside hooks/", (t) => {
  const b = box(t);
  assert.deepEqual(restore(lib, b.target, FROM, "", b.hooksDir), { proven: false,
    why: "no checkout resolved via the control-plane pointer, the deliver-hook command, workspace, KHEREP_WORKSPACE or install note" });
  assert.deepEqual(restore(lib, b.target, FROM, b.repo, b.hooksDir), { proven: false, why: `versioned source ${FROM} unreadable (ENOENT)` });
  b.version(FROM, "");
  assert.deepEqual(restore(lib, b.target, FROM, b.repo, b.hooksDir), { proven: false, why: `versioned source ${FROM} is itself 0 bytes` });
  b.version(FROM, "export {};\n");
  const outside = restore(lib, path.join(b.root, "elsewhere", "x.mts"), FROM, b.repo, b.hooksDir);
  assert.equal(outside.proven, false);
  assert.ok(outside.why, "the write refusal is the reason");
  assert.equal(fs.existsSync(path.join(b.root, "elsewhere")), false);
});

test("restore: proven only as the bytes measured at the target, from the checkout or the snapshot", (t) => {
  const b = box(t);
  b.version(FROM, "export const a = 1;\n");
  assert.deepEqual(restore(lib, b.target, FROM, b.repo, b.hooksDir), { proven: true, sha: sha("export const a = 1;\n") });
  b.snapshot({ [FROM]: "export const b = 2;\n" });
  assert.deepEqual(restore(lib, b.target, FROM, "", b.hooksDir), { proven: true, sha: sha("export const b = 2;\n") }, "the snapshot wins");
  assert.equal(fs.readFileSync(b.target, "utf8"), "export const b = 2;\n");
  b.snapshot({ [FROM]: "export {};\n" }, { [FROM]: sha("other") });
  assert.deepEqual(restore(lib, b.target, FROM, b.repo, b.hooksDir), { proven: false, why: "observation source snapshot is unverified" });
});

test("journal appends one line, and a home it cannot write is ignored", (t) => {
  const b = box(t);
  journal(b.home, { n: 1 });
  journal(b.home, { n: 2 });
  assert.equal(fs.readFileSync(path.join(b.home, ".cache", "hook-integrity", "incidents.jsonl"), "utf8"), '{"n":1}\n{"n":2}\n');
  const file = path.join(b.root, "a-file");
  fs.writeFileSync(file, "");
  assert.doesNotThrow(() => journal(file, { n: 3 }));
});

test("sourceReaders: the live file, else the versioned one, with the computed imports appended", (t) => {
  const b = box(t);
  const ctx = (repoRoot: string) => ({ home: b.home, repoRoot, sourceOf, COMPUTED, computedImports, realOrNull: () => null }) as unknown as Ctx;
  const shell = "kherep-maestro/codex-shell-checks.mts", plain = "kherep-maestro/codex-hook-integrity-sources.mts";
  const live = path.join(b.hooksDir, shell);
  const { liveOnly, readSource } = sourceReaders(lib, ctx(b.repo));
  assert.equal(liveOnly(live, shell), null, "missing");
  fs.writeFileSync(live, "");
  assert.equal(liveOnly(live, shell), null, "empty");
  fs.writeFileSync(live, "export {};\n");
  assert.deepEqual(liveOnly(live, shell), { text: `export {};\n${computedImports(shell)}`, real: undefined });
  fs.rmSync(live);
  b.version("codex/hooks/shell-checks.mts", "// versioned\n");
  assert.equal(readSource(live, shell), `// versioned\n${computedImports(shell)}`);
  assert.equal(readSource(b.target, plain), null, "neither live nor versioned");
  assert.equal(readSource(path.join(b.hooksDir, "x.mts"), "x.mts"), null, "no versioned source at all");
  assert.equal(sourceReaders(lib, ctx("")).readSource(live, shell), computedImports(shell), "no checkout: only the computed imports");
  b.snapshot({ [FROM]: "export {};\n" }, { [FROM]: sha("other") });
  assert.equal(readSource(b.target, plain), null, "an unverified snapshot reads as nothing");
});

test("entryChecker: a broken rendered file is reported only; a restore of broken bytes is proven but still not OK", async (t) => {
  const b = box(t);
  const lines: string[] = [];
  const lock = { holding: () => true, release: (): void => {} };
  const outcome = (result: Restored): string => result.proven ? "RESTORED" : `NOT restored (${result.why})`;
  const check = entryChecker(lib, { home: b.home, hooksDir: b.hooksDir, repoRoot: b.repo, lock, trigger: "test", lines, lost: "lost", sourceOf, COMPUTED,
    computedImports, outcome, realOrNull: () => null });
  const rendered = path.join(b.hooksDir, "kherep-maestro", "codex-observation-stop.mts");
  fs.writeFileSync(rendered, "");
  assert.deepEqual(await check({ file: rendered, rel: "kherep-maestro/codex-observation-stop.mts", wired: true, importedBy: [] }),
    { unproven: "kherep-maestro/codex-observation-stop.mts is not restored", restored: false });
  assert.match(lines[0]!, /-> NOT restored, report only \(rendered by the installer, no byte-identical source; run codex\/install\.mts\)\. ENFORCEMENT IS OFF/);
  b.version("claude/hooks/broken-guard.mts", "export const = ;\n");
  const broken = path.join(b.hooksDir, "kherep-maestro", "broken-guard.mts");
  fs.writeFileSync(broken, "");
  assert.deepEqual(await check({ file: broken, rel: "kherep-maestro/broken-guard.mts", wired: false, importedBy: ["kherep-maestro/x.mts"] }),
    { unproven: "kherep-maestro/broken-guard.mts is not OK after the restore", restored: true });
  assert.match(lines[1]!, /^kherep-maestro\/broken-guard\.mts \(imported by kherep-maestro\/x\.mts\): .* -> RESTORED$/);
  assert.match(lines[2]!, /^kherep-maestro\/broken-guard\.mts \(imported by kherep-maestro\/x\.mts\): still [A-Z]+ after the restore$/);
  const entries = fs.readFileSync(path.join(b.home, ".cache", "hook-integrity", "incidents.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.restoreProven]), [["wired", false], ["import", true]]);
});
