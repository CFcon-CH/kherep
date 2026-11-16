import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Fixed refusal codes of the model-selection Git adapter (issue #737). A code
// names the condition only; no path, revision or command output is echoed.
export const GIT_REFUSAL = Object.freeze({
  headUnresolved: "model-selection-head-unresolved",
  sourceDirty: "model-selection-source-dirty",
  revisionAbsent: "model-selection-revision-absent",
  sourceAbsent: "model-selection-source-absent",
});
export class ModelSelectionRefusal extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code} (${detail})` : code);
    this.name = "ModelSelectionRefusal";
    this.code = code;
  }
}

// One read surface for the inventory builder: the working tree or one commit.
export interface SourceReader {
  read(relative: string): string;
  // File names (not paths) directly inside a repository directory; [] when absent.
  list(relativeDirectory: string): string[];
}
export interface ModelSelectionGit {
  head(): string;
  // B1: codex/parity/**, claude/agents/*.md and codex/agents/*.md are clean.
  assertClean(): void;
  at(revision: string): SourceReader;
  workingTree(): SourceReader;
}
export type GitRunner = (args: readonly string[]) => { status: number | null; stdout: Buffer };

export const CLEAN_PATHSPECS = Object.freeze([":(glob)codex/parity/**", ":(glob)claude/agents/*.md", ":(glob)codex/agents/*.md"]);
const REVISION = /^[a-f0-9]{40}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

function relativePath(relative: string): string {
  const parts = relative.split("/");
  if (!parts.length || parts.some((part) => !SEGMENT.test(part) || part === "." || part === "..")) {
    throw new ModelSelectionRefusal(GIT_REFUSAL.sourceAbsent);
  }
  return parts.join("/");
}

// The inherited environment must not redirect which repository is read.
function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

export function gitRunner(repoRoot: string): GitRunner {
  const env = gitEnvironment();
  return (args) => {
    const result = spawnSync("git", ["-C", repoRoot, ...args], { env, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return { status: result.error ? null : result.status, stdout: result.stdout ?? Buffer.alloc(0) };
  };
}

export function workingTreeReader(repoRoot: string): SourceReader {
  return {
    read(relative) {
      try { return fs.readFileSync(path.join(repoRoot, ...relativePath(relative).split("/")), "utf8"); }
      catch { throw new ModelSelectionRefusal(GIT_REFUSAL.sourceAbsent); }
    },
    list(relativeDirectory) {
      const directory = path.join(repoRoot, ...relativePath(relativeDirectory).split("/"));
      if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
      return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    },
  };
}

// Both paths resolved natively; Windows paths compare case-insensitively, since
// Git and the installer may spell the same directory with different casing.
export function sameTopLevel(top: string | undefined, repoRoot: string, platform: string = process.platform,
  realpath: (file: string) => string = fs.realpathSync.native): boolean {
  if (!top) return false;
  let left: string, right: string;
  try { [left, right] = [realpath(top), realpath(repoRoot)]; } catch { return false; }
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// The checkout must be the repository's own top level: a source tree copied
// into an unrelated parent repository must not borrow that parent's HEAD.
export function modelSelectionGit(repoRoot: string, run: GitRunner = gitRunner(repoRoot)): ModelSelectionGit {
  const text = (args: readonly string[]): string | null => {
    const result = run(args);
    return result.status === 0 ? result.stdout.toString("utf8") : null;
  };
  let resolved: string | undefined;
  return {
    head() {
      if (resolved) return resolved;
      const top = text(["rev-parse", "--show-toplevel"])?.trim();
      const head = text(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.trim();
      if (!sameTopLevel(top, repoRoot) || !head || !REVISION.test(head)) throw new ModelSelectionRefusal(GIT_REFUSAL.headUnresolved);
      resolved = head;
      return head;
    },
    assertClean() {
      this.head();
      const status = text(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...CLEAN_PATHSPECS]);
      if (status === null) throw new ModelSelectionRefusal(GIT_REFUSAL.headUnresolved);
      if (status.length) throw new ModelSelectionRefusal(GIT_REFUSAL.sourceDirty);
    },
    at(revision) {
      this.head();
      if (typeof revision !== "string" || !REVISION.test(revision) || text(["cat-file", "-e", `${revision}^{commit}`]) === null) {
        throw new ModelSelectionRefusal(GIT_REFUSAL.revisionAbsent);
      }
      return {
        read(relative) {
          const value = text(["cat-file", "blob", `${revision}:${relativePath(relative)}`]);
          if (value === null) throw new ModelSelectionRefusal(GIT_REFUSAL.sourceAbsent);
          return value;
        },
        list(relativeDirectory) {
          const listing = text(["ls-tree", "-z", "--full-tree", revision, "--", `${relativePath(relativeDirectory)}/`]);
          if (listing === null) throw new ModelSelectionRefusal(GIT_REFUSAL.sourceAbsent);
          return listing.split("\0").filter(Boolean).map((row) => row.split("\t"))
            .filter(([meta]) => meta!.split(" ")[1] === "blob").map(([, name]) => name!.split("/").at(-1)!).sort();
        },
      };
    },
    workingTree() { return workingTreeReader(repoRoot); },
  };
}
