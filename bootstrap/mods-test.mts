#!/usr/bin/env node
// Issue #757. npm run test:mods: `claude plugin validate` and `claude plugin test` on every
// mod under claude/mods/. The mods API ships with the Claude Code CLI, so without `claude` on
// PATH (as in CI) the run prints SKIP and exits 0; that is an unavailable check, not a pass.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const MODS = path.resolve(import.meta.dirname, "..", "claude", "mods");
// npm installs the CLI as claude.cmd on Windows, which spawn runs only through cmd.exe;
// the arguments are then quoted, since cmd.exe splits a path with spaces.
const SHELL = process.platform === "win32";

function claude(args: string[]): { status: number | null; output: string } {
  const options = { encoding: "utf8", timeout: 300_000 } as const;
  const run = SHELL
    ? spawnSync(["claude", ...args.map((arg) => `"${arg}"`)].join(" "), { ...options, shell: true })
    : spawnSync("claude", args, options);
  return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

// where.exe answers in every display language by its exit code; elsewhere spawn says ENOENT.
function onPath(): boolean {
  if (SHELL) return spawnSync("where", ["claude"], { stdio: "ignore" }).status === 0;
  return !spawnSync("claude", ["--version"], { stdio: "ignore" }).error;
}

function main(): number {
  if (!onPath()) {
    console.log("SKIP: claude not on PATH");
    return 0;
  }
  const mods = fs.existsSync(MODS) ? fs.readdirSync(MODS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  let failed = 0;
  for (const mod of mods.sort()) {
    const dir = path.join(MODS, mod);
    for (const step of [["plugin", "validate", dir], ["plugin", "test", dir]]) {
      const run = claude(step);
      const label = `${step[1]} ${mod}`;
      if (run.status === 0) {
        console.log(`PASS: ${label}`);
      } else {
        failed++;
        console.log(`FAIL: ${label} (exit ${run.status})\n${run.output.trimEnd()}`);
      }
    }
  }
  if (!mods.length) console.log("SKIP: no mods under claude/mods");
  return failed ? 1 : 0;
}

process.exitCode = main();
