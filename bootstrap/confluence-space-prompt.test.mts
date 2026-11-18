// Issue #965. The terminal prompt of bootstrap/confluence-space.mts: with no
// space key in the environment or a stored file, a terminal is asked once. The
// terminal preload gives the step its terminal branch over a plain pipe.
// Declared byte-identical copies, stub broker and stub placement read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { declareCopy } from "./coverage-copy-fixture.mts";

const HERE = import.meta.dirname;
const PRELOAD = pathToFileURL(path.join(HERE, "terminal-preload.fixture.mts")).href;
const PROMPT = "Confluence knowledge space key (e.g. KB): ";

function tree(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-confluence-prompt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bootstrap = path.join(root, "bootstrap");
  const brokers = path.join(root, "modules", "atl-jira-brokers");
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.mkdirSync(brokers, { recursive: true });
  for (const file of ["confluence-space.mts", "render-profile-paths.mts", "shape.mts"]) {
    fs.copyFileSync(path.join(HERE, file), path.join(bootstrap, file));
    declareCopy(path.join(HERE, file), path.join(bootstrap, file));
  }
  fs.writeFileSync(path.join(bootstrap, "confluence-nodes.mts"), [
    'export const PLACEMENT_NODES = ["Kherep"];',
    "export async function readSpacePages() { return []; }",
    'export function resolvePlacement() { return { nodes: { Kherep: "parent-1" }, missing: [] }; }',
  ].join("\n"));
  // Echoes the requested key back, so the stored key proves which answer was read.
  fs.writeFileSync(path.join(brokers, "atl-confluence.mts"),
    'const key = process.argv[process.argv.indexOf("--space") + 1];\n'
    + 'process.stdout.write(`id: space-1\\nkey: ${key}\\nname: Synthetic Space\\n`);\n');
  const target = path.join(root, "home", "confluence.json");
  const run = (stdin: string | number, args = ["--runtime", "codex"]) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.KHEREP_CONFLUENCE_SPACE_KEY;
    return spawnSync(process.execPath, ["--import", PRELOAD, path.join(bootstrap, "confluence-space.mts"),
      "--out", target, ...args], {
      encoding: "utf8", env, timeout: 60_000,
      ...(typeof stdin === "string" ? { input: stdin } : { stdio: [stdin, "pipe", "pipe"] }),
    });
  };
  return { root, target, run };
}

test("the space key typed at the terminal is resolved and stored", (t) => {
  const space = tree(t);
  const result = space.run(" SYNTH \n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${PROMPT}confluence space: configured\nplacement nodes: 1 of 1 resolved\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(space.target, "utf8")), {
    spaceKey: "SYNTH", spaceId: "space-1", spaceName: "Synthetic Space", nodes: { Kherep: "parent-1" },
  });
});

test("an empty answer stores nothing", (t) => {
  const space = tree(t);
  const result = space.run("\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FATAL: No space key given\.$/m);
  assert.equal(fs.existsSync(space.target), false);
});

test("a terminal that cannot be read names the variable to set instead", (t) => {
  const space = tree(t);
  const descriptor = fs.openSync(path.join(space.root, "write-only"), "w");
  t.after(() => fs.closeSync(descriptor));
  const result = space.run(descriptor);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FATAL: Could not read the space key from the terminal\. Set KHEREP_CONFLUENCE_SPACE_KEY instead\.$/m);
  assert.equal(fs.existsSync(space.target), false);
});

test("observation publishing authority is refused for Claude before anything is asked", (t) => {
  const space = tree(t);
  const result = space.run("SYNTH\n", ["--runtime", "claude", "--profile", "mac", "--workspace", "/synthetic/workspace",
    "--authorize-observation-publishing"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^FATAL: Observation publishing authority is Codex-only\.$/m);
  assert.equal(fs.existsSync(space.target), false);
});

test("importing the module from an eval entry configures nothing", () => {
  const code = `await import(${JSON.stringify(pathToFileURL(path.join(HERE, "confluence-space.mts")).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /FATAL/);
});
