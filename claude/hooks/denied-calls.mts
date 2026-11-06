#!/usr/bin/env node
// Issue #504. The Maestro's read path for the denied-call journal, an operator CLI, never wired
// as a hook (hook integrity does not restore it; the installers do):
//   node "<CLAUDE_HOME>/hooks/denied-calls.mts" render <agent_id>
//   node "<CLAUDE_HOME>/hooks/denied-calls.mts" list [--minutes <n>]
//   node "<CLAUDE_HOME>/hooks/denied-calls.mts" prune
// Codex installs it as <CODEX_HOME>/hooks/kherep-maestro/denied-calls.mts. The home is
// derived from where it is installed; --home <dir> names another one. render exits 3 on
// `unknown`, so a caller sees UNKNOWN without parsing; list is a diagnostic, never evidence.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { listRows, prune, readJournal, renderReport } from "./lib/denial-report.mts";

const USAGE = "usage: denied-calls.mts render <agent_id> | list [--minutes <n>] | prune [--home <dir>]";

// <CLAUDE_HOME> is the parent of hooks/; the Codex copy sits one level deeper, in hooks/kherep-maestro/.
export function homeOf(script: string): string {
  const dir = path.dirname(path.resolve(script));
  return path.basename(dir) === "kherep-maestro" ? path.dirname(path.dirname(dir)) : path.dirname(dir);
}

export function run(argv: string[], script: string): { text: string; exit: number } {
  const args = [...argv];
  const at = args.indexOf("--home");
  const home = at >= 0 ? args.splice(at, 2)[1] : homeOf(script);
  if (!home) return { text: `${USAGE}\n`, exit: 2 };
  const [command, value, extra] = args;
  if (command === "render" && args.length <= 2) return renderReport(readJournal(home, value ?? ""));
  if (command === "list") {
    const minutes = value === "--minutes" ? Number(extra) : value === undefined ? 60 : Number.NaN;
    if (!Number.isFinite(minutes) || minutes <= 0) return { text: `${USAGE}\n`, exit: 2 };
    return { text: `${listRows(home, minutes * 60_000).join("\n")}\n`, exit: 0 };
  }
  if (command === "prune" && args.length === 1) return { text: `pruned ${prune(home)}\n`, exit: 0 };
  return { text: `${USAGE}\n`, exit: 2 };
}

function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch { return false; }
}

if (isMainModule()) {
  const { text, exit } = run(process.argv.slice(2), process.argv[1]!);
  process.stdout.write(text, () => process.exit(exit));
}
