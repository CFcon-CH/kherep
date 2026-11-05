// Keep dependency lifecycle scripts disabled in every checked-in workflow (#779).
// Workflows use plain npm commands; no YAML parser or shell execution is needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const workflows = path.resolve(import.meta.dirname, "../.github/workflows");

function unsafeInstalls(file: string, source: string): string[] {
  const refused: string[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    const code = line.split("#", 1)[0];
    for (const command of code.split(/&&|\|\||[;|]/)) {
      const words = command.trim().split(/\s+/);
      for (let i = 0; i + 1 < words.length; i++) {
        if (words[i] !== "npm" || words[i + 1] !== "ci") continue;
        const flags = words.slice(i + 2).filter((word) => word === "--ignore-scripts" || word.startsWith("--ignore-scripts="));
        if (!["--ignore-scripts", "--ignore-scripts=true"].includes(flags.at(-1) ?? "")) refused.push(`${file}:${index + 1}`);
      }
    }
  }
  return refused;
}

test("every workflow npm ci disables lifecycle scripts", () => {
  const files = fs.readdirSync(workflows).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort((left, right) => left.localeCompare(right));
  assert.ok(files.length > 0, "no workflow files found");
  const refused = files.flatMap((file) => unsafeInstalls(file, fs.readFileSync(path.join(workflows, file), "utf8")));
  assert.deepEqual(refused, [], "unguarded npm ci commands");
});

test("the install policy rejects missing, false and overridden flags, including compound commands", () => {
  assert.deepEqual(unsafeInstalls("fixture.yml", [
    "run: npm ci", "run: npm ci --ignore-scripts=false", "run: npm ci --ignore-scripts --ignore-scripts=false",
    "run: npm ci && npm ci --ignore-scripts", "# npm ci", "run: npm ci --ignore-scripts=true",
  ].join("\n")), ["fixture.yml:1", "fixture.yml:2", "fixture.yml:3", "fixture.yml:4"]);
});

test("the Worker clean install includes optional platform binaries with scripts disabled", () => {
  const source = fs.readFileSync(path.join(workflows, "ci.yml"), "utf8");
  const start = source.indexOf("\n  control-plane-worker:\n");
  assert.ok(start >= 0, "the Worker job is present");
  const end = source.indexOf("\n  client-binding-probe:\n", start);
  assert.ok(end > start, "the next job bounds the Worker job");
  assert.ok(source.slice(start, end).split("\n").some((line) => line.trim() === "- run: npm ci --ignore-scripts --include=optional"));
});
