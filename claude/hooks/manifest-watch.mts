#!/usr/bin/env node
// PostToolUse hook: surfaces a diff summary whenever Edit/Write touches a Forge manifest.yml.
// Soft warning only - never blocks. Goal: scope additions never sneak through silently.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findTrustedExecutable } from "./lib/trusted-executable.mts";

const TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const ADDED_SCOPE = /^\+\s*-\s*[a-z]+:[\w-]+(?::[\w-]+)*\s*$/i;
const REMOVED_SCOPE = /^-\s*-\s*[a-z]+:[\w-]+(?::[\w-]+)*\s*$/i;
const SCOPE_WORD = /scope|read|write|admin|delete|manage/i;

// The two fields this hook reads. The rest of a PostToolUse payload stays
// unread and is therefore not typed here.
interface ManifestPayload {
  tool_name?: unknown;
  tool_input?: { file_path?: unknown; path?: unknown } | null;
}

function manifestPath(payload: ManifestPayload | null): string {
  if (!payload || !TOOLS.includes(String(payload.tool_name))) return "";
  const input = payload.tool_input ?? {};
  const filePath = typeof input.file_path === "string" ? input.file_path
    : typeof input.path === "string" ? input.path : "";
  return /manifest\.ya?ml$/i.test(filePath) ? filePath : "";
}

// spawnSync with an argv array: git args are passed directly and never
// parsed by a shell, so a manifest path containing shell metacharacters
// ($(), backticks, ;, |) cannot inject a command. Hardened from the prior
// execSync template-string form (flagged HIGH command-injection 2026-06-11).
function diffAgainstHead(repoDir: string, filePath: string): string {
  const command = findTrustedExecutable("git");
  if (!command) return "";
  const res = spawnSync(command, ["-C", repoDir, "diff", "HEAD", "--", filePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.error || res.status !== 0) return "";
  return res.stdout || "";
}

function summary(filePath: string, repoDir: string, diff: string): string {
  const addedScopes: string[] = [];
  const removedScopes: string[] = [];
  for (const line of diff.split("\n")) {
    if (!SCOPE_WORD.test(line)) continue;
    if (ADDED_SCOPE.test(line)) addedScopes.push(line.trim());
    if (REMOVED_SCOPE.test(line)) removedScopes.push(line.trim());
  }

  let msg = `[manifest-watch] ${path.basename(filePath)} changed vs HEAD.\n`;
  if (addedScopes.length) {
    msg += `ADDED scopes (require user re-consent on install):\n  ${addedScopes.join("\n  ")}\n`;
  }
  if (removedScopes.length) {
    msg += `REMOVED scopes (existing installs may break):\n  ${removedScopes.join("\n  ")}\n`;
  }
  if (!addedScopes.length && !removedScopes.length) {
    msg += "(no scope-line changes detected, other manifest fields modified)\n";
  }
  return `${msg}Run \`git -C "${repoDir}" diff HEAD -- ${path.basename(filePath)}\` for the full diff.`;
}

function main(): void {
  try {
    const filePath = manifestPath(JSON.parse(fs.readFileSync(0, "utf8")) as ManifestPayload | null);
    if (!filePath) return;
    const repoDir = path.dirname(filePath);
    const diff = diffAgainstHead(repoDir, filePath);
    if (!diff.trim()) return;
    process.stdout.write(`${summary(filePath, repoDir, diff)}\n`);
  } catch {
    // Fail-open: a hook that cannot answer says nothing and exits 0.
  }
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

if (isMainModule()) main();
