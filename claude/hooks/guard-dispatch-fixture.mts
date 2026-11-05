// Shared fixture of the guard-dispatch suites (issue #507). The dispatcher and
// its re-check lib are copied into a temporary hooks/ directory, next to which
// a suite writes synthetic guards; the temporary root plays the Claude home of
// that copy. A missing heartbeat or lib adds a re-check notice by design
// (part 2, rows D2 and D9), so the root gets a fresh heartbeat unless a suite
// asks for none: a suite about guard verdicts then sees only its guards.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

export interface DispatcherFixture { root: string; hooks: string; dispatch: string }

export function heartbeatPath(root: string): string {
  return path.join(root, ".cache", "hook-integrity", "heartbeat.json");
}

// mtime ageMs in the past; written fresh when ageMs is 0.
export function plantHeartbeat(root: string, ageMs = 0): void {
  const file = heartbeatPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(file, then, then);
}

export function dispatcherFixture(prefix: string, { heartbeat = true } = {}): DispatcherFixture {
  // Real path: macOS tmpdir is a symlink, and Node names the main module by its real path.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const hooks = path.join(root, "hooks");
  const dispatch = path.join(hooks, "guard-dispatch.mts");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "guard-dispatch.mts"), dispatch);
  declareCopy(path.join(import.meta.dirname, "guard-dispatch.mts"), dispatch);
  fs.copyFileSync(path.join(import.meta.dirname, "lib", "guard-recheck.mts"), path.join(hooks, "lib", "guard-recheck.mts"));
  if (heartbeat) plantHeartbeat(root);
  return { root, hooks, dispatch };
}
