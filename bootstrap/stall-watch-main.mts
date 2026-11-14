// Issue #744. Entry point of .github/workflows/stall-watch.yml; the logic lives in stall-watch.mts.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { run } from "./stall-watch.mts";
import { githubClient } from "./stall-watch-github.mts";

// Node resolves argv[1] through symlinks for import.meta.url unless --preserve-symlinks-main
// keeps the path as given, so both forms count.
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
  const token = process.env.GITHUB_TOKEN || "";
  const gh = githubClient({ api: process.env.GITHUB_API_URL || "https://api.github.com", token, fetch });
  const result = token ? await run(process.env, gh, Date.now()) : { code: 2, lines: ["GITHUB_TOKEN is missing"] };
  for (const line of result.lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Stall watch\n\n${result.lines.map((l) => `- ${l}`).join("\n")}\n`);
  }
  process.exitCode = result.code;
}
