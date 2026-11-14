#!/usr/bin/env node
// Builds the public tree of one revision: the `git archive` content of that
// commit (attributes applied, no .git), minus the paths listed in the
// revision's own exclude file. Usage: public-export.mts <revision> <outDir>
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readTar } from "./public-export-tar.mts";
import { requireTrustedExecutable } from "../claude/hooks/lib/trusted-executable.mts";

export const EXCLUDE_FILE = "bootstrap/manifest/public-export-exclude.txt";

export interface ExportResult {
  revision: string;
  outDir: string;
  files: number;
  manifest: string;
}

export function parseExcludes(source: string): string[] {
  const patterns = source.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const pattern of patterns) {
    if (!pattern.endsWith("/") || pattern.startsWith("/")
      || pattern.slice(0, -1).split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Invalid export exclude entry: ${pattern}`);
    }
  }
  if (!patterns.length) throw new Error("The export exclude list is empty");
  return patterns;
}

export function isExcluded(file: string, patterns: string[]): boolean {
  const directories = file.split("/").slice(0, -1);
  return patterns.some((pattern) => {
    const name = pattern.slice(0, -1);
    return name.includes("/") ? `${file}/`.startsWith(pattern) : directories.includes(name);
  });
}

function git(repo: string, args: string[]): Buffer {
  return execFileSync(requireTrustedExecutable("git"), ["-C", repo, ...args], { maxBuffer: 1024 * 1024 * 1024 });
}

interface Found { files: string[]; directories: string[] }

function walk(root: string): Found {
  const found: Found = { files: [], directories: [] };
  collect(root, "", found);
  return found;
}

function collect(root: string, relative: string, found: Found): void {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink remains in the export: ${child}`);
    if (entry.isDirectory()) { found.directories.push(child); collect(root, child, found); }
    else if (entry.isFile()) found.files.push(child);
    else throw new Error(`Unsupported file type in the export: ${child}`);
  }
}

export function exportRevision(repo: string, revision: string, outDir: string): ExportResult {
  const sha = git(repo, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).toString().trim();
  const patterns = parseExcludes(git(repo, ["show", `${sha}:${EXCLUDE_FILE}`]).toString("utf8"));
  const target = path.resolve(outDir);
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error("The output directory is not empty");
  fs.mkdirSync(target, { recursive: true });
  const expected: string[] = [];
  for (const entry of readTar(git(repo, ["archive", "--format=tar", sha]))) {
    if (entry.type === "directory") continue;
    if (isExcluded(entry.path, patterns)) continue;
    if (entry.type !== "file") throw new Error(`Non-regular entry in the export: ${entry.path}`);
    const file = path.join(target, ...entry.path.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
    expected.push(entry.path);
  }
  const { files, directories } = walk(target);
  // A directory counts as excluded when a file inside it would be.
  const leaked = [...files.filter((file) => isExcluded(file, patterns)),
    ...directories.filter((directory) => isExcluded(`${directory}/x`, patterns))];
  if (leaked.length) throw new Error(`Excluded path remains in the export: ${leaked[0]}`);
  files.sort((left, right) => Number(left > right) - Number(left < right));
  if (JSON.stringify(files) !== JSON.stringify(expected.sort((left, right) => Number(left > right) - Number(left < right)))) {
    throw new Error("The exported file set does not match the revision");
  }
  const manifest = `${target}.sha256`;
  fs.writeFileSync(manifest, files.map((file) => {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(target, file))).digest("hex");
    return `${digest}  ${file}\n`;
  }).join(""));
  return { revision: sha, outDir: target, files: files.length, manifest };
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [revision, outDir] = process.argv.slice(2);
  try {
    if (!revision || !outDir) throw new Error("Usage: public-export.mts <revision> <outDir>");
    const repo = path.resolve(import.meta.dirname, "..");
    const result = exportRevision(repo, revision, outDir);
    console.log(`revision ${result.revision}`);
    console.log(`files ${result.files}`);
    console.log(`manifest ${result.manifest}`);
  } catch (error) {
    console.error(`Public export failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
