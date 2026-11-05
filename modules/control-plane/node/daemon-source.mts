import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findTrustedExecutable } from "../../../claude/hooks/lib/trusted-executable.mts";

export const SOURCE_MANIFEST = ".kherep-source.json";

export interface SourceIdentity {
  root: string;
  commit: string;
  digest: string;
  kind: "checkout" | "pin";
  verified: boolean;
}

export interface SourceManifest {
  version: 1;
  commit: string;
  digest: string;
  filesDigest: string;
  files: { path: string; mode: "100644" | "100755"; digest: string }[];
}

export type SourceComparison = { status: "match" } | { status: "mismatch"; reason: "commit" | "digest" }
  | { status: "unknown"; reason: string };

const cleanGitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function git(root: string, args: string[], encoding: BufferEncoding | "buffer" = "utf8"): string | Buffer {
  const command = findTrustedExecutable("git");
  if (!command) throw new Error(`source identity unavailable: git ${args[0]} failed`);
  const result = spawnSync(command, ["-C", root, ...args], {
    encoding: encoding === "buffer" ? null : encoding,
    env: cleanGitEnv(), windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`source identity unavailable: git ${args[0]} failed`);
  return result.stdout as string | Buffer;
}

const validCommit = (value: string): boolean => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
const sha256 = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");

function safeFile(root: string, relative: string): { digest: string; bytes: Buffer } {
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error("source manifest escapes its root");
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`source pins do not support symbolic links: ${relative}`);
  if (!stat.isFile()) throw new Error(`source entry is not a regular file: ${relative}`);
  const bytes = fs.readFileSync(resolved);
  return { digest: sha256(bytes), bytes };
}

function manifestDigest(files: SourceManifest["files"]): string {
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(file.mode).update("\0").update(file.path).update("\0").update(file.digest).update("\0");
  return hash.digest("hex");
}

function actualFiles(root: string, relative = ""): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && entry.name === SOURCE_MANIFEST) continue;
    const stat = fs.lstatSync(path.join(root, ...name.split("/")));
    if (stat.isSymbolicLink()) throw new Error(`source pins do not support symbolic links: ${name}`);
    if (stat.isDirectory()) result.push(...actualFiles(root, name));
    else if (stat.isFile()) result.push(name);
    else throw new Error(`source entry is not a regular file: ${name}`);
  }
  return result.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function treeDigest(root: string, files: SourceManifest["files"], algorithm: "sha1" | "sha256"): string {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const { bytes } = safeFile(root, file.path);
    const blob = crypto.createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    chunks.push(Buffer.from(`${file.mode} blob ${blob}\t${file.path}\0`));
  }
  return sha256(Buffer.concat(chunks));
}

function checkoutIdentity(root: string, requireClean: boolean): SourceIdentity {
  const canonical = fs.realpathSync.native(root);
  const top = String(git(canonical, ["rev-parse", "--show-toplevel"])).trim();
  if (fs.realpathSync.native(top) !== canonical) throw new Error("source must be a repository root");
  const commit = String(git(canonical, ["rev-parse", "--verify", "HEAD^{commit}"])).trim().toLowerCase();
  if (!validCommit(commit)) throw new Error("source commit is unknown");
  const command = findTrustedExecutable("git");
  if (!command) throw new Error("source cleanliness is unknown");
  const dirty = spawnSync(command, ["-C", canonical, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8", env: cleanGitEnv(), windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (dirty.status !== 0) throw new Error("source cleanliness is unknown");
  const clean = dirty.stdout.trim().length === 0;
  if (requireClean && !clean) throw new Error("tracked source is dirty");
  const tree = git(canonical, ["ls-tree", "-rz", "--full-tree", "-r", commit], "buffer") as Buffer;
  return { root: canonical, commit, digest: sha256(tree), kind: "checkout", verified: clean };
}

function pinIdentity(root: string): SourceIdentity {
  const canonical = fs.realpathSync.native(root);
  const value = JSON.parse(fs.readFileSync(path.join(canonical, SOURCE_MANIFEST), "utf8")) as SourceManifest;
  if (value.version !== 1 || !validCommit(value.commit) || !Array.isArray(value.files)) throw new Error("source pin manifest is invalid");
  const files = value.files.map((entry) => {
    if (!entry || typeof entry.path !== "string" || !["100644", "100755"].includes(entry.mode) || typeof entry.digest !== "string") {
      throw new Error("source pin manifest is invalid");
    }
    const actual = safeFile(canonical, entry.path);
    if (actual.digest !== entry.digest) throw new Error(`source pin drift: ${entry.path}`);
    return entry;
  });
  const listed = files.map(file => file.path).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (new Set(listed).size !== listed.length || JSON.stringify(actualFiles(canonical)) !== JSON.stringify(listed)) {
    throw new Error("source pin inventory does not match its manifest");
  }
  if (manifestDigest(files) !== value.filesDigest) throw new Error("source pin manifest digest does not match its files");
  if (!/^[0-9a-f]{64}$/.test(value.digest)) throw new Error("source pin manifest is invalid");
  const algorithm = value.commit.length === 64 ? "sha256" : "sha1";
  if (treeDigest(canonical, files, algorithm) !== value.digest) throw new Error("source pin content does not match its checkout tree");
  return { root: canonical, commit: value.commit.toLowerCase(), digest: value.digest, kind: "pin", verified: true };
}

export function captureSourceIdentity(root: string, requireClean = true): SourceIdentity {
  return fs.existsSync(path.join(root, SOURCE_MANIFEST)) ? pinIdentity(root) : checkoutIdentity(root, requireClean);
}

export const runtimeSourceRoot = (): string => path.resolve(import.meta.dirname, "..", "..", "..");
export const captureRuntimeSourceIdentity = (): SourceIdentity => captureSourceIdentity(runtimeSourceRoot(), false);

export function compareSourceIdentity(expected: SourceIdentity | undefined, actual: SourceIdentity | undefined): SourceComparison {
  if (!expected?.verified || !actual?.verified) return { status: "unknown", reason: "source identity is not verified" };
  if (expected.commit !== actual.commit) return { status: "mismatch", reason: "commit" };
  if (expected.digest !== actual.digest) return { status: "mismatch", reason: "digest" };
  return { status: "match" };
}

export function createSourceManifest(root: string, filesRoot: string, commit: string, digest: string): SourceManifest {
  const rows = (git(root, ["ls-tree", "-rz", "--full-tree", "-r", commit], "buffer") as Buffer).toString("utf8").split("\0").filter(Boolean);
  const files = rows.map((row) => {
    const match = /^(100644|100755) blob [0-9a-f]+\t(.+)$/u.exec(row);
    if (!match) throw new Error("source tree contains an unsupported entry");
    const filePath = match[2].replace(/\\/g, "/");
    return { path: filePath, mode: match[1] as "100644" | "100755", digest: safeFile(filesRoot, filePath).digest };
  });
  return { version: 1, commit, digest, filesDigest: manifestDigest(files), files };
}
