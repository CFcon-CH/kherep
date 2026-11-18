// Issue #965. The secret-wrapper migration as install.sh runs it: the CLI
// writes the token and the registry as two fresh files, and a failure on the
// second removes the first, so no half-migrated pair is left behind. The
// contract refusals of migrateRegistry are pinned below through the export.
// Synthetic token, reserved domain, temp directories only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { migrateRegistry } from "./migrate-mcp-secret-wrapper.mts";

const SUBJECT = path.join(import.meta.dirname, "migrate-mcp-secret-wrapper.mts");
const TOKEN = `header.${"x".repeat(40)}.${"y".repeat(40)}`;
const ENDPOINT = "https://service.example.invalid/mcp-server/http";
// readRegistry and writeFreshText refuse a POSIX path with a symlinked component
// (macOS /var -> /private/var), so the temp root is resolved first there.
const TEMP_ROOT = process.platform === "win32" ? os.tmpdir() : fs.realpathSync(os.tmpdir());

function bridge() {
  return {
    preserved: true,
    mcpServers: {
      n8n: {
        command: "npx",
        args: ["-y", "supergateway", "--streamableHttp", ENDPOINT, "--header", `Authorization: Bearer ${TOKEN}`],
        env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } as Record<string, unknown>,
      } as Record<string, unknown>,
    },
  };
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, "kherep-mcp-wrapper-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    input: path.join(root, "input.json"),
    registry: path.join(root, "registry.json"),
    token: path.join(root, "n8n.token"),
    wrapper: path.join(root, "supergateway-secret-wrapper.mts"),
    installedToken: path.join(root, "installed", "n8n.token"),
  };
  return files;
}

type Files = ReturnType<typeof fixture>;

function run(files: Files, overrides: Partial<Record<keyof Files, string>> = {}, drop = 0) {
  const f = { ...files, ...overrides };
  const args = [f.input, f.registry, f.token, "n8n", f.wrapper, f.installedToken].slice(0, 6 - drop);
  return spawnSync(process.execPath, [SUBJECT, ...args], { encoding: "utf8" });
}

const escaped = TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the CLI isolates the bearer token in its own fresh file and rewrites the registry", (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.input, JSON.stringify(bridge()));
  const result = run(files);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "MCP auth isolated: n8n -> secret wrapper\n");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(escaped));
  assert.equal(fs.readFileSync(files.token, "utf8"), `${TOKEN}\n`);
  const registry = JSON.parse(fs.readFileSync(files.registry, "utf8"));
  assert.deepEqual(registry.mcpServers.n8n, {
    command: "node", args: [files.wrapper],
    env: { KHEREP_MCP_AUTH_FILE: files.installedToken, KHEREP_MCP_ENDPOINT: ENDPOINT, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  });
  assert.equal(registry.preserved, true);
});

test("an entry already on the wrapper only moves its path and writes no token file", (t) => {
  const files = fixture(t);
  const env = { KHEREP_MCP_AUTH_FILE: files.installedToken, KHEREP_MCP_ENDPOINT: ENDPOINT, NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  fs.writeFileSync(files.input, JSON.stringify({ mcpServers: { n8n: { command: "node", args: ["/old/supergateway-secret-wrapper.js"], env } } }));
  const result = run(files);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `MCP wrapper path updated: n8n -> ${files.wrapper}\n`);
  assert.equal(fs.existsSync(files.token), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.registry, "utf8")).mcpServers.n8n.args, [files.wrapper]);
});

test("a registry output that already exists removes the token file this run created", (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.input, JSON.stringify(bridge()));
  fs.writeFileSync(files.registry, "operator registry\n");
  const result = run(files);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^MCP wrapper migration failed: .*EEXIST/m);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(escaped));
  assert.equal(fs.existsSync(files.token), false, "the token written for this run is gone again");
  assert.equal(fs.readFileSync(files.registry, "utf8"), "operator registry\n");
});

test("a token output that already exists is never overwritten and no registry is written", (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.input, JSON.stringify(bridge()));
  fs.writeFileSync(files.token, "earlier token\n");
  const result = run(files);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(fs.readFileSync(files.token, "utf8"), "earlier token\n");
  assert.equal(fs.existsSync(files.registry), false);
});

test("missing arguments and colliding outputs are a usage error that writes nothing", (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.input, JSON.stringify(bridge()));
  for (const result of [run(files, {}, 1), run(files, { registry: files.input }), run(files, { token: files.registry })]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^MCP wrapper migration failed: usage: <input-registry>/m);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(files.input)), ["input.json"]);
});

test("importing the module from an eval entry runs no migration", () => {
  const code = `await import(${JSON.stringify(pathToFileURL(SUBJECT).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /MCP wrapper migration failed/);
});

test("the contract refuses unsafe names, relative paths and every unknown entry shape", () => {
  const wrapper = "C:\\Users\\example\\supergateway-secret-wrapper.mts";
  const token = "C:\\Users\\example\\n8n.token";
  const wrapped = (env: unknown) => ({ mcpServers: { n8n: { command: "node", args: ["/old/supergateway-secret-wrapper.mts"], env } } });
  const mutated = (change: (server: Record<string, unknown>) => void) => {
    const value = bridge();
    change(value.mcpServers.n8n);
    return value;
  };
  const cases: Array<[() => unknown, RegExp]> = [
    [() => migrateRegistry(bridge(), "n8n server", wrapper, token), /invalid MCP server name/],
    [() => migrateRegistry(bridge(), "n8n", "relative/wrapper.mts", token), /must be absolute/],
    [() => migrateRegistry(bridge(), "n8n", wrapper, "relative.token"), /must be absolute/],
    [() => migrateRegistry({}, "n8n", wrapper, token), /MCP server is missing/],
    [() => migrateRegistry(mutated((s) => { s.type = "stdio"; }), "n8n", wrapper, token), /unsupported fields/],
    [() => migrateRegistry(wrapped("not an object"), "n8n", wrapper, token), /wrapper entry environment/],
    [() => migrateRegistry(wrapped({ KHEREP_MCP_AUTH_FILE: token, KHEREP_MCP_ENDPOINT: ENDPOINT, NODE_TLS_REJECT_UNAUTHORIZED: "1" }), "n8n", wrapper, token), /wrapper entry environment/],
    [() => migrateRegistry(mutated((s) => { s.command = "node"; }), "n8n", wrapper, token), /not an npx stdio bridge/],
    [() => migrateRegistry(mutated((s) => { s.args = "not a list"; }), "n8n", wrapper, token), /not an npx stdio bridge/],
    [() => migrateRegistry(mutated((s) => { s.env = Object.assign(Object.create(null), { NODE_TLS_REJECT_UNAUTHORIZED: "0" }); }), "n8n", wrapper, token), /scoped TLS exception/],
    [() => migrateRegistry(mutated((s) => { (s.args as string[])[3] = "not a url"; }), "n8n", wrapper, token), /endpoint is invalid/],
    [() => migrateRegistry(mutated((s) => { (s.args as string[])[5] = "Authorization: Bearer short"; }), "n8n", wrapper, token), /bearer header is invalid/],
    [() => migrateRegistry(mutated((s) => { (s.args as string[])[5] = "X-Other: value"; }), "n8n", wrapper, token), /bearer header is invalid/],
  ];
  for (const [call, message] of cases) assert.throws(call, message);
  assert.equal(migrateRegistry(bridge(), "n8n", wrapper, token).token, TOKEN, "a Windows absolute path is accepted");
});
