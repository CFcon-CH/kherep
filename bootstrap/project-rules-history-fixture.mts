import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEMPLATE_PATHS = ["claude/CLAUDE.project.md", "claude/AGENTS.project.md"];
export const LEGACY_CUTOFF = "2026-09-24T00:00:00Z";
export const LAST_WHOLE_FILE_COMMIT = "226c6d35388bfc1d57a2fb1f40b852141c7020ea";
// Both project templates at v0.1.0 (226c6d3), copied whole by its installer.
export const LEGACY_TEMPLATE = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "project-rules-v0.1.0.md"), "utf8");

export function git(repo: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", input });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export function wholeFileTemplateBlobs(repo: string, publicBoundary = LAST_WHOLE_FILE_COMMIT): string[] {
  const commits = git(repo, ["rev-list", "--all", `--until=${LEGACY_CUTOFF}`, "--", ...TEMPLATE_PATHS]);
  // Resolve commits first: --objects --all also walks non-commit refs (such as
  // archived trees), which --until cannot filter. The public release is newer too,
  // but must deliberately be included; its successor installs marked blocks.
  const boundary = git(repo, ["rev-parse", "--verify", `${publicBoundary}^{commit}`]).trim();
  const roots = [...new Set([...commits.trim().split(/\r?\n/).filter(Boolean), boundary])];
  return git(repo, ["rev-list", "--objects", "--stdin", "--", ...TEMPLATE_PATHS], `${roots.join("\n")}\n`)
    .split(/\r?\n/).filter((line) => / claude\/(CLAUDE|AGENTS)\.project\.md$/.test(line));
}

export function historyFixture(t: { after: (fn: () => void) => void }): {
  repo: string; commit: (text: string, date: string) => string;
} {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-project-history-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.name", "Synthetic Fixture"]);
  git(repo, ["config", "user.email", "fixture@example.org"]);
  fs.mkdirSync(path.join(repo, "claude"));
  return { repo, commit(text, date) {
    fs.writeFileSync(path.join(repo, TEMPLATE_PATHS[1]), text);
    git(repo, ["add", "--", TEMPLATE_PATHS[1]]);
    const result = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic template"], {
      cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return git(repo, ["rev-parse", "HEAD"]).trim();
  } };
}
