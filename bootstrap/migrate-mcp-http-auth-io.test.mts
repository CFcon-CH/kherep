// Issue #965. The refusals of migrate-mcp-http-auth.mts that the contract
// tests next door leave open: a registry that is no readable regular JSON
// object, an output parent that is no real directory, a write that fails after
// the fresh file was created, the usage error and an import that is no CLI run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { migrateRegistry, readRegistry, writeFreshText } from "./migrate-mcp-http-auth.mts";

const SUBJECT = path.join(import.meta.dirname, "migrate-mcp-http-auth.mts");
const TOKEN = `header.${"x".repeat(40)}.${"y".repeat(40)}`;
const POSIX = process.platform !== "win32";
const TEMP_ROOT = POSIX ? fs.realpathSync(os.tmpdir()) : os.tmpdir();

function tempRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, "kherep-mcp-http-io-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function bridge(): { mcpServers: Record<string, Record<string, unknown>> } {
  return {
    mcpServers: {
      n8n: {
        command: "npx",
        args: ["-y", "supergateway", "--streamableHttp", "https://service.example.invalid/mcp", "--header", `authorization: Bearer ${TOKEN}`],
      },
    },
  };
}

test("a registry that is missing, a directory or no JSON object is refused by name", (t) => {
  const root = tempRoot(t);
  assert.throws(() => readRegistry(path.join(root, "absent.json")),
    POSIX ? /input registry cannot be opened safely/ : /input registry cannot be read safely/);
  assert.throws(() => readRegistry(root), /input registry must be a regular file/);
  const list = path.join(root, "list.json");
  fs.writeFileSync(list, "[]");
  assert.throws(() => readRegistry(list), /registry must be an object/);
});

const unreadable = !POSIX || process.getuid?.() === 0;
test("a POSIX registry the user may not read is refused without its content", { skip: unreadable }, (t) => {
  const file = path.join(tempRoot(t), "private.json");
  fs.writeFileSync(file, JSON.stringify(bridge()), { mode: 0o000 });
  assert.throws(() => readRegistry(file), /^Error: input registry cannot be read safely$/);
});

test("the contract refuses unsafe names, missing servers, extra fields and a malformed bridge", () => {
  const mutated = (change: (server: Record<string, unknown>) => void) => {
    const value = bridge();
    change(value.mcpServers.n8n);
    return value;
  };
  const cases: Array<[() => unknown, RegExp]> = [
    [() => migrateRegistry(bridge(), "n8n/other"), /invalid MCP server name/],
    [() => migrateRegistry({}, "n8n"), /MCP server is missing/],
    [() => migrateRegistry({ mcpServers: { n8n: "npx" } }, "n8n"), /MCP server is missing/],
    [() => migrateRegistry(mutated((s) => { s.type = "stdio"; }), "n8n"), /stdio server has unsupported fields/],
    [() => migrateRegistry(mutated((s) => { s.command = "node"; }), "n8n"), /not an npx stdio bridge/],
    [() => migrateRegistry(mutated((s) => { s.env = Object.create(null); }), "n8n"), /environment must be absent or an empty object/],
    [() => migrateRegistry(mutated((s) => { (s.args as string[])[3] = "not a url"; }), "n8n"), /stdio bridge endpoint is invalid/],
    [() => migrateRegistry(mutated((s) => { (s.args as string[])[5] = "authorization: Bearer short"; }), "n8n"), /bearer header is invalid/],
    [() => migrateRegistry(mutated((s) => { (s.args as string[])[5] = "X-Other: value"; }), "n8n"), /bearer header is invalid/],
  ];
  for (const [call, message] of cases) assert.throws(call, message);
});

test("an output parent that is no directory is refused before anything is created", (t) => {
  const root = tempRoot(t);
  const file = path.join(root, "a-file");
  fs.writeFileSync(file, "");
  assert.throws(() => writeFreshText(path.join(file, "output.json"), "{}\n"), /output parent must be a real directory/);
});

test("a POSIX output parent reached through a symlinked ancestor is refused", { skip: !POSIX }, (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "real", "sub"), { recursive: true });
  fs.symlinkSync(path.join(root, "real"), path.join(root, "linked"), "dir");
  const output = path.join(root, "linked", "sub", "output.json");
  assert.throws(() => writeFreshText(output, "{}\n"), /output parent path must not contain symbolic links/);
  assert.equal(fs.existsSync(path.join(root, "real", "sub", "output.json")), false);
});

test("a write that fails after the fresh file was created removes that file again", (t) => {
  const output = path.join(tempRoot(t), "output.json");
  // The text is not writable data, so the failure comes after the exclusive create.
  assert.throws(() => writeFreshText(output, 42 as unknown as string), { code: "ERR_INVALID_ARG_TYPE" });
  assert.equal(fs.existsSync(output), false);
});

test("the CLI refuses missing arguments and an output equal to the input", (t) => {
  const root = tempRoot(t);
  const input = path.join(root, "input.json");
  fs.writeFileSync(input, JSON.stringify(bridge()));
  for (const args of [[input, path.join(root, "out.json")], [input, input, "n8n"]]) {
    const result = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^MCP migration failed: usage: <input-registry> <fresh-output> <server-name>$/m);
  }
  assert.equal(fs.readFileSync(input, "utf8"), JSON.stringify(bridge()));
  assert.deepEqual(fs.readdirSync(root), ["input.json"]);
});

test("importing the module from an eval entry runs no migration", () => {
  const code = `await import(${JSON.stringify(pathToFileURL(SUBJECT).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /MCP migration failed/);
});
