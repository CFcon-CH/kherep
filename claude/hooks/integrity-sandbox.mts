// Shared harness of the live-hook-integrity suites (issue #507, part 2). Since
// the hook repairs only inside the hook runtime's hold on the hooks directory
// it runs from, every case copies the hook and its libs into the sandbox's
// hooks/, wires its fixture hooks in the coordinated form, and starts the hook
// through this checkout's kherep/hook-runtime/entry.mts in writer mode, the
// way the installed SessionStart command does. Nothing under the developer's
// real ~/.claude is read or written.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

const HOOKS_SOURCE = import.meta.dirname;
export const ENTRY = path.resolve(HOOKS_SOURCE, "..", "kherep", "hook-runtime", "entry.mts");
export const HOOK = "live-hook-integrity.mts";

// The entry of the installation hooksDir belongs to: <home>/kherep/hook-runtime beside <home>/hooks.
export const entryFor = (hooksDir: string): string => path.join(path.dirname(hooksDir), "kherep", "hook-runtime", "entry.mts");

// This checkout's runtime beside hooksDir, once.
function ensureRuntime(hooksDir: string): void {
  if (!fs.existsSync(entryFor(hooksDir))) fs.cpSync(path.dirname(ENTRY), path.dirname(entryFor(hooksDir)), { recursive: true });
}

// The hook and every non-test lib, byte for byte, into hooksDir, and the runtime beside it.
export function installIntegrity(hooksDir: string): void {
  fs.mkdirSync(path.join(hooksDir, "lib"), { recursive: true });
  ensureRuntime(hooksDir);
  fs.copyFileSync(path.join(HOOKS_SOURCE, HOOK), path.join(hooksDir, HOOK));
  for (const name of fs.readdirSync(path.join(HOOKS_SOURCE, "lib"))) {
    if (name.endsWith(".mts") && !name.endsWith(".test.mts")) {
      fs.copyFileSync(path.join(HOOKS_SOURCE, "lib", name), path.join(hooksDir, "lib", name));
    }
  }
}

// `node <file under hooks/> ...` in the form the installed settings use; anything else unchanged.
export function coordinated(command: string, mode = "reader"): string {
  const match = /^(&\s+)?node\s+(\S*\/hooks\/\S+)(.*)$/.exec(command);
  return match ? `${match[1] ?? ""}node ~/.claude/kherep/hook-runtime/entry.mts ${mode} ${match[2]}${match[3]}` : command;
}

export interface Result { status: number | null; stdout: string; stderr: string }

// The hook in hooksDir, admitted as the integrity writer.
export function runIntegrity(hooksDir: string, input: string, env: NodeJS.ProcessEnv, args: string[] = []): Result {
  ensureRuntime(hooksDir);
  declareCopy(path.join(HOOKS_SOURCE, HOOK), path.join(hooksDir, HOOK));
  const run = spawnSync(process.execPath, [entryFor(hooksDir), "writer", path.join(hooksDir, HOOK), ...args],
    { input, encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// The same hook started directly, without the runtime: it must repair nothing.
export function runUncoordinated(hooksDir: string, input: string, env: NodeJS.ProcessEnv, args: string[] = []): Result {
  declareCopy(path.join(HOOKS_SOURCE, HOOK), path.join(hooksDir, HOOK));
  const run = spawnSync(process.execPath, [path.join(hooksDir, HOOK), ...args], { input, encoding: "utf8", env, windowsHide: true });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
