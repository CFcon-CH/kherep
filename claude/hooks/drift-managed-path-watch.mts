#!/usr/bin/env node
/**
 * drift-managed-path-watch.mts  -  PostToolUse hook (Edit|Write|MultiEdit)
 *
 * Says at WRITE TIME that the file just written is one that
 * bootstrap/drift-check.sh manages, and names its versioned source in the repo.
 *
 * The gap this closes: drift-check-nudge.mts is a SessionStart hook that replays
 * the PREVIOUS run's report and only nags at 24h staleness. Between the edit and
 * the next session start nothing says a word. On 2026-08-06 an edit to
 * D:\workspace\CLAUDE.md produced no hint at all that claude/CLAUDE.project.md is
 * its source - only umlaut-translit-watch fired.
 *
 * The live -> source map lives in drift-managed-pairs.mts, next to this file.
 * drift-managed-path-watch.test.mts parses the cmp_file/cmp_tree invocations out
 * of drift-check.sh and asserts that map covers every live target they name, so
 * the two cannot drift apart unnoticed.
 *
 * Fail-safe: soft warning only, never blocks, any error exits 0 silently.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fixedPairs, manifestPairs, type ManagedPair } from "./drift-managed-pairs.mts";
import {
  isKherepScope,
  isWithinPath,
  normalizePathLike,
  workspaceForPayload,
  type ScopePayload,
} from "./lib/workspace-scope.mts";

interface WatchPayload extends ScopePayload {
  tool_name?: unknown;
  tool_input?: { file_path?: unknown; path?: unknown } | null;
}

interface Match {
  live: string;
  source: string;
  rendered: boolean;
  block: boolean;
}

function claudeHome(): string {
  return normalizePathLike(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
}

// Longest live path wins, so a file entry nested inside a directory entry names
// itself rather than its parent. Comparison is delegated to workspace-scope,
// which normalizes separators, "." segments and case, and rejects an empty root
// on its own - hence no separate guard for a pair without a live path.
function matchFor(written: unknown, pairs: ManagedPair[]): Match | null {
  const target = normalizePathLike(written);
  if (!target) return null;
  let best: ManagedPair | null = null;
  let bestLive = "";
  for (const pair of pairs) {
    const live = normalizePathLike(pair.live);
    if (!isWithinPath(target, live)) continue;
    if (live.length > bestLive.length) {
      best = pair;
      bestLive = live;
    }
  }
  if (!best) return null;
  // Keep the sub-path when the entry is a directory: name the actual source file.
  const suffix = target.slice(bestLive.length);
  return { live: target, source: best.source + suffix, rendered: Boolean(best.rendered), block: Boolean(best.block) };
}

function carryHint(match: Match): string {
  if (match.block) {
    return `Only the <!-- kherep-project-rules --> block is managed; text outside it is operator content and never drift. `
      + `If the edit is inside the block, carry it into the source in the SAME working step.`;
  }
  if (/^claude\/agents\/[^/]+\.md$/.test(match.source)) {
    return "The live frontmatter model: and effort: are rendered from kherep/model-policy.json plus "
      + "<CLAUDE_HOME>/kherep/model-policy.user.json; change model or effort in the user file, anything else in the source. "
      + "A live-only edit is overwritten on the next install.";
  }
  if (match.rendered) {
    return `The live file is BUILT from that source by install.sh, so the edit belongs in the source - `
      + `a live-only change is overwritten on the next install.`;
  }
  return `Carry this change into the repo source in the SAME working step - a live-only change is lost `
    + `on the next install and shows up as unreconciled drift.`;
}

function message(match: Match): string {
  const carry = carryHint(match);
  return (
    `[drift-managed-path-watch] ${match.live} is managed by kherep/bootstrap/drift-check.sh.\n`
    + `Versioned source: kherep/${match.source}\n`
    // English throughout, like the neighbouring hooks: a German rule title here
    // would need real Umlauts and this file stays ASCII.
    + `${carry} CLAUDE.md goldene Regel 14: live change and repo commit in the same working step.`
  );
}

function finding(payload: WatchPayload | null): Match | null {
  if (!payload || !["Edit", "Write", "MultiEdit"].includes(String(payload.tool_name))) return null;

  // Same scope gate as drift-check-nudge.mts. The workspace is also what resolves
  // the project pairs and the manifest, so there is nothing to say without one.
  if (!isKherepScope(payload)) return null;
  const workspace = workspaceForPayload(payload);

  const input = payload.tool_input ?? {};
  const filePath = typeof input.file_path === "string" ? input.file_path
    : typeof input.path === "string" ? input.path : "";
  if (!filePath) return null;

  const home = claudeHome();
  return matchFor(filePath, [...fixedPairs(home, workspace), ...manifestPairs(home, workspace)]);
}

function main(): void {
  try {
    const match = finding(JSON.parse(fs.readFileSync(0, "utf8")) as WatchPayload | null);
    if (!match) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message(match) },
        systemMessage: `drift-managed file edited - source: kherep/${match.source}`,
      }),
    );
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
