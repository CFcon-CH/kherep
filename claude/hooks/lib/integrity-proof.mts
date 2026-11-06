// The final, read-only proof of an integrity run (issue #507, part 2).
//
// After the repair passes, and still under the same EXCLUSIVE hold on the hooks
// directory, the closure is walked once more from the live wired files only:
// no versioned source stands in for a missing file here. Every file is read
// once into a snapshot (bytes, SHA-256, identity), its imports come from that
// snapshot and resolve from its real path (issue #524), and its syntax is
// checked; before and after each check, and once more for all of them at the
// end, the bytes on disk must still be the snapshot. A file whose real path
// leaves the hooks directory is not covered by the hold and counts as
// unchecked. The wiring must read the same at the end.
// Only then may the heartbeat be written. What this proves is the supported
// inventory and syntax checks, not that every module can execute.
//
// The syntax verdict is bound to the snapshot: it parses the string built from
// the snapshot's bytes, in process, and opens no path (P2). A .js file gets the
// grammar Node loads it with: its package scope is the nearest package.json from
// the file's real directory upward to the file system root, stopping at a
// directory named node_modules. Inside the hooks root every candidate is
// present (snapshotted like a hook file and re-checked at the end), proven absent
// (and still absent at the end), or not proven, which proves nothing. Limits: a
// package.json above the hooks root is outside the hold and read once; a read
// error, or a package.json that is not a regular file, is not proven although
// Node would pass it over; the accepted forms are those Node 26.10 accepts
// (measured, see configScope).
// "CommonJS, else ESM" follows Node's syntax detection on every measured case.
// Static imports: node:* only; the libs arrive as a parameter.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { HookFile } from "./hook-inventory.mts";
import type { SyntaxVerdict } from "./hook-syntax.mts";

export type ProofLibs = Pick<typeof import("./hook-inventory.mts"), "hookInventory" | "wiredFiles">
  & Pick<typeof import("./hook-syntax.mts"), "syntaxVerdict" | "esmParses" | "cjsParses">;
export type Scope = "module" | "commonjs" | "none" | "invalid";
// `real` is the path the bytes were read from: a wired name that is a link is only an
// alias, and Node loads its target, so the grammar and the package scope come from it.
interface Snap { buf: Buffer; sha: string; dev: bigint; ino: bigint; real: string }

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

function snapshot(file: string, root: string): Snap | null {
  try {
    const real = fs.realpathSync(file);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const st = fs.statSync(real, { bigint: true });
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(real);
    return { buf, sha: sha256(buf), dev: st.dev, ino: st.ino, real };
  } catch {
    return null;
  }
}

const unchanged = (file: string, root: string, snap: Snap): boolean => {
  const now = snapshot(file, root);
  return !!now && now.sha === snap.sha && now.dev === snap.dev && now.ino === snap.ino && now.real === snap.real;
};

// true only for a name that is proven not to exist; any other failure proves nothing.
function absentName(file: string): boolean {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    return codeOf(error) === "ENOENT";
  }
}

// The top-level members of an object text JSON.parse accepted, as raw key and value
// tokens, every duplicate included: JSON.parse keeps only the last of each key.
function members(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let key = "";
  let valueAt = -1;
  let i = -1;
  while (++i < text.length) {
    const c = text[i];
    if (c === "\"") {
      const from = i;
      i++;
      while (text[i] !== "\"") { if (text[i] === "\\") i++; i++; }
      if (depth === 1 && valueAt < 0) key = text.slice(from, i + 1);
    } else if (c === "{" || c === "[") depth++;
    else if (depth === 1 && valueAt < 0 && c === ":") valueAt = i + 1;
    else if (depth === 1 && valueAt >= 0 && (c === "," || c === "}")) {
      out.push([key, text.slice(valueAt, i).trim()]);
      valueAt = -1;
      if (c === "}") depth--;
    } else if (c === "}" || c === "]") depth--;
  }
  return out;
}

// The scope a package.json text gives, as Node 26.10 reads it (measured): an object;
// every top-level "type" and "name", duplicates included, must be a string, matched by
// its raw key (an escaped key is another key); the last "type" that is "module" or
// "commonjs" decides, any other string leaves it as it was. Anything else is "invalid".
function configScope(text: string): Scope {
  const clean = text.replace(/^\uFEFF/, "");
  let config: unknown;
  try { config = JSON.parse(clean); } catch { return "invalid"; }
  if (!config || typeof config !== "object" || Array.isArray(config)) return "invalid";
  let scope: Scope = "none";
  for (const [key, value] of members(clean)) {
    if (key !== "\"type\"" && key !== "\"name\"") continue;
    if (!value.startsWith("\"")) return "invalid";
    const field = JSON.parse(value) as string;
    if (key === "\"type\"" && (field === "module" || field === "commonjs")) scope = field;
  }
  return scope;
}

// One package.json candidate in dir: its scope, or null when it is absent there.
function candidateScope(dir: string, root: string, take: (file: string) => Snap | null, absent: Set<string>): Scope | null {
  const candidate = path.join(dir, "package.json");
  const rel = path.relative(root, dir);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    if (absentName(candidate)) {
      absent.add(candidate);
      return null;
    }
    const snap = take(candidate);
    return snap ? configScope(snap.buf.toString("utf8")) : "invalid";
  }
  try {
    return configScope(fs.readFileSync(candidate, "utf8"));
  } catch (error) {
    return codeOf(error) === "ENOENT" ? null : "invalid";
  }
}

// The package scope of the .js file `file`, as the header describes it, the file
// system root included; `absent` collects the candidates inside the root that were
// proven absent. `parentOf` is a test seam (an injected file system root); the proof
// never passes it.
export function scopeOf(file: string, root: string, take: (file: string) => Snap | null, absent: Set<string>,
  parentOf: (dir: string) => string = path.dirname): Scope {
  let dir: string;
  try { dir = path.dirname(fs.realpathSync(file)); } catch { return "invalid"; }
  for (;; dir = parentOf(dir)) {
    if (path.basename(dir) === "node_modules") return "none";
    const scope = candidateScope(dir, root, take, absent);
    if (scope) return scope;
    if (parentOf(dir) === dir) return "none";
  }
}

// The verdict over exactly `source`: `file` picks the grammar by its extension and
// names the source in errors, nothing reads it. `scope` matters for .js only.
export async function boundVerdict(lib: Pick<ProofLibs, "syntaxVerdict" | "esmParses" | "cjsParses">, file: string, source: string,
  scope: Scope): Promise<SyntaxVerdict> {
  const ext = path.extname(file).toLowerCase();
  if (!source.length || (ext !== ".js" && ext !== ".cjs")) return lib.syntaxVerdict(file, source); // .mts/.mjs parse the string
  if (ext === ".cjs") return lib.cjsParses(source, file);
  if (scope === "invalid") return { state: "UNGEPRUEFT", detail: "the package scope could not be read" };
  if (scope === "module") return lib.esmParses(source);
  const cjs = lib.cjsParses(source, file);
  if (scope === "commonjs" || cjs.state === "OK") return cjs;
  // Node's detection: a module only where CommonJS failed.
  return (await lib.esmParses(source)).state === "OK" ? { state: "OK" } : cjs;
}

const sameFiles = (a: HookFile[], b: HookFile[]): boolean =>
  a.length === b.length && a.every((file, index) => file.file === b[index]?.file);

// "" with the file count when the live closure passed, otherwise why it did not.
export async function finalProof(lib: ProofLibs, home: string, root: string, files: HookFile[]): Promise<{ why: string; count: number }> {
  const snaps = new Map<string, Snap | null>();
  const absent = new Set<string>();
  const take = (file: string): Snap | null => {
    if (!snaps.has(file)) snaps.set(file, snapshot(file, root));
    return snaps.get(file)!;
  };
  const inventory = lib.hookInventory(files, `${home}/hooks`, (file) => {
    const snap = take(file);
    return snap && snap.buf.length ? { text: snap.buf.toString("utf8"), real: snap.real } : null;
  }, root);
  const count = inventory.length;
  for (const { file, rel } of inventory) {
    const snap = take(file);
    if (!snap || !snap.buf.length) return { why: `${rel} could not be proven in the final check`, count };
    // Grammar and scope of the target the bytes came from; `rel` only names it.
    const scope = path.extname(snap.real).toLowerCase() === ".js" ? scopeOf(snap.real, root, take, absent) : "none";
    const verdict = await boundVerdict(lib, snap.real, snap.buf.toString("utf8"), scope);
    if (verdict.state !== "OK") return { why: `${rel} is not OK in the final check`, count };
    if (!unchanged(file, root, snap)) return { why: `${rel} changed during the final check`, count };
  }
  for (const [file, snap] of snaps) {
    if (snap && !unchanged(file, root, snap)) return { why: "a file changed during the final check", count };
  }
  for (const file of absent) {
    if (!absentName(file)) return { why: "a file changed during the final check", count };
  }
  const again = lib.wiredFiles(home);
  if (again.notes.length || again.uncoordinated.length || !sameFiles(again.files, files)) {
    return { why: "the wiring changed during the final check", count };
  }
  return { why: "", count };
}
