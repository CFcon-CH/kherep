// Issue #973. Entry point of .github/workflows/ci-rerun.yml; the logic lives in ci-rerun.mts.
// The client admits one write only: POST /repos/<owner>/<repo>/actions/runs/<id>/rerun-failed-jobs
// with body {}, and none at all in a dry run (guardWrites).

import fs from "node:fs";

import { guardWrites, realClock, run } from "./ci-rerun.mts";
import { githubClient } from "./stall-watch-github.mts";

const env = process.env;
const token = env.GITHUB_TOKEN || "";
const client = githubClient({ api: env.GITHUB_API_URL || "https://api.github.com", token, fetch });
const gh = guardWrites(client, env.GITHUB_REPOSITORY || "", env.CI_RERUN_DRY_RUN === "true");
const result = token ? await run(env, gh, realClock) : { code: 2, lines: ["GITHUB_TOKEN is missing"] };
for (const line of result.lines) console.log(line);
if (env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## CI rerun\n\n${result.lines.map((line) => `- ${line}`).join("\n")}\n`);
}
process.exitCode = result.code;
