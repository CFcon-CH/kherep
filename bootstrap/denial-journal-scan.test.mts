import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { targetOf } from "../claude/hooks/lib/denial-journal.mts";

const target = (command: string) => targetOf({ tool_name: "Bash", tool_input: { command } });

test("environment prefixes keep quoted semicolons and repeated assignments out of the target", () => {
  for (const command of [
    "$env:A='a;b'; $env:B = \"c;d\" ; FOO=bar /usr/bin/git push",
    "$ENV:A=;\t$env:B = x;  git push",
    "FOO=1 BAR=x git push",
    "  '/opt/my app/git' push  ",
  ]) assert.equal(target(command), "git", command);
  for (const command of ["$env:1A=x; git", "$env:A='unterminated", "'unterminated", "FOO=1"]) {
    assert.equal(target(command), "-", command);
  }
});

test("adversarial whitespace is bounded in a separate process and oversized input is neutral", () => {
  const moduleUrl = new URL("../claude/hooks/lib/denial-journal.mts", import.meta.url).href;
  const source = `import fs from 'node:fs'; import {targetOf} from ${JSON.stringify(moduleUrl)};
    const command=fs.readFileSync(0,'utf8'); console.log(targetOf({tool_name:'Bash',tool_input:{command}}));`;
  const start = performance.now();
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    input: "$env:A=" + " ".repeat(50_000) + "!", encoding: "utf8", timeout: 3_000,
  });
  assert.equal(run.error, undefined, `scanner exceeded runtime bound: ${run.error?.message}`);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "-");
  assert.ok(performance.now() - start < 3_000, "scanner took over 3 seconds including process startup");
  assert.equal(target("FOO=x ".repeat(100_000) + "git push"), "-");
});
