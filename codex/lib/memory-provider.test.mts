import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { configureMemoryNotify, parseCentralBrainBinding, resolveMemoryProvider } from "./memory-provider.mts";
import * as providerApi from "./memory-provider.mts";
import { spawnSync } from "node:child_process";
import { renderMcp } from "./parity-config.mts";

// OP-1429. The server-based Central Brain is retired. An explicit selection of
// it is refused; a persisted one is reported as retired and the install goes on
// unconfigured, with the old binding kept only to recognise the old block.
const unconfigured = { memoryProvider: { provider: "unconfigured" } };

function persisted(t: TestContext, value: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "memory-provider.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test("an explicit Central Brain selection is refused as retired", () => {
  const base = { provider: "central-brain", mcpCli: path.resolve("synthetic/mcp.mjs"),
    profile: path.resolve("synthetic/nonexistent-profile.json") };
  assert.throws(() => resolveMemoryProvider("unused", base), /^Error: The Central Brain memory provider is retired$/);
  assert.deepEqual(resolveMemoryProvider("unused", { provider: "unconfigured" }), unconfigured);
  for (const value of [null, [], { provider: "typo" }, { provider: "unconfigured", extra: 1 }]) {
    assert.throws(() => resolveMemoryProvider("unused", value), /^Error: Memory provider selection is invalid$/);
  }
});

test("a persisted Central Brain selection is retired with its exact binding", (t) => {
  const base = { provider: "central-brain", mcpCli: path.resolve("synthetic/mcp.mjs"),
    profile: path.resolve("synthetic/nonexistent-profile.json") };
  const nativeHooks = { contextCli: path.resolve("synthetic/native-context.js"),
    captureCli: path.resolve("synthetic/native-capture.mjs") };
  assert.deepEqual(resolveMemoryProvider(persisted(t, base)), { ...unconfigured,
    retired: { provider: "central-brain", binding: { mcpCli: base.mcpCli, profile: base.profile } } });
  assert.deepEqual(resolveMemoryProvider(persisted(t, { ...base, nativeHooks })), { ...unconfigured,
    retired: { provider: "central-brain", binding: { mcpCli: base.mcpCli, profile: base.profile, nativeHooks } } });
  assert.equal(fs.existsSync(base.profile), false, "the referenced profile is never read or created");
});

test("a persisted Central Brain selection the old installer never wrote is retired without a binding", (t) => {
  const base = { provider: "central-brain", mcpCli: path.resolve("synthetic/mcp.mjs"), profile: "relative.json" };
  for (const value of [base, { ...base, profile: path.resolve("p.json"), nativeHooks: {} }, { provider: "central-brain" }]) {
    assert.deepEqual(resolveMemoryProvider(persisted(t, value)), { ...unconfigured, retired: { provider: "central-brain" } });
  }
});

test("the old binding validation is kept for recognising the old block", () => {
  const base = { provider: "central-brain", mcpCli: path.resolve("synthetic/mcp.mjs"),
    profile: path.resolve("synthetic/nonexistent-profile.json") };
  const nativeHooks = { contextCli: path.resolve("synthetic/native-context.js"),
    captureCli: path.resolve("synthetic/native-capture.mjs") };
  for (const binding of [{}, { contextCli: nativeHooks.contextCli },
    { ...nativeHooks, captureCli: "relative.mjs" }, { ...nativeHooks, extra: true },
    { ...nativeHooks, contextCli: `${nativeHooks.contextCli}\ncommand` }, null]) {
    assert.throws(() => parseCentralBrainBinding({ ...base, nativeHooks: binding }),
      /^Error: Memory provider selection is invalid$/);
  }
});

test("missing memory selection is unconfigured and invalid selection fails closed", (t) => {
  const missing = path.join(os.tmpdir(), randomUUID(), "selection.json");
  assert.throws(() => resolveMemoryProvider(missing, null), /selection is invalid/);
  assert.deepEqual(resolveMemoryProvider(missing), unconfigured);
  assert.throws(() => resolveMemoryProvider(persisted(t, { provider: "typo" })), /selection is invalid/);
});

test("native binding captures validated path references once", () => {
  const good = path.resolve("synthetic/context.js");
  let reads = 0;
  const selection = { provider: "central-brain", mcpCli: good, profile: good,
    nativeHooks: { get contextCli() { reads += 1; return reads === 1 ? good : "unvalidated-relative"; }, captureCli: good } };
  assert.equal(parseCentralBrainBinding(selection).nativeHooks?.contextCli, good);
  assert.equal(reads, 1);
});

test("native literal quoting accepts POSIX shell metacharacters and rejects Windows expansion", () => {
  const literal = Reflect.get(providerApi, "nativeCommand");
  assert.equal(typeof literal, "function", "new native commands need a literal binding renderer");
  const vectors = ['space name', '%VAR%', 'bang!', 'double"quote', "apostrophe'name", '$(echo expanded)', '`echo expanded`'];
  for (const part of vectors) {
    assert.equal(literal([part], "linux"), `'${part.replaceAll("'", `'"'"'`)}'`);
    if (/["%!]/.test(part)) assert.throws(() => literal([part], "win32"), /^Error: Native hook command binding is invalid$/);
    else assert.equal(literal([part], "win32"), `"${part}"`);
  }
  for (const part of ['line\nbreak', 'null\0byte', 'carriage\rreturn']) {
    for (const platform of ['win32', 'linux'] as const) assert.throws(() => literal([part], platform));
  }
});

test("POSIX native command shell passes every accepted argument literally", { skip: process.platform === "win32" }, () => {
  const literal = Reflect.get(providerApi, "nativeCommand");
  assert.equal(typeof literal, "function");
  const parts = ['/synthetic/space name', '/synthetic/%VAR%', '/synthetic/bang!', '/synthetic/double"quote',
    "/synthetic/apostrophe'name", '/synthetic/$(echo expanded)', '/synthetic/`echo expanded`'];
  const result = spawnSync('/bin/sh', ['-c', literal([process.execPath, '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...parts], "linux")], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), parts);
});

test("native selection rejects Windows-unrepresentable bindings without changing old three-field compatibility", {
  skip: process.platform !== "win32",
}, () => {
  const safe = path.resolve('synthetic/space apostrophe\' $() `tick');
  const base = { provider: 'central-brain', mcpCli: `${safe}%VAR%`, profile: safe };
  assert.deepEqual(parseCentralBrainBinding(base), { mcpCli: base.mcpCli, profile: base.profile });
  for (const field of ['contextCli', 'captureCli', 'profile']) for (const suffix of ['%VAR%', '!', '"']) {
    const selection = { ...base, nativeHooks: { contextCli: safe, captureCli: safe } };
    if (field === 'profile') selection.profile += suffix;
    else Reflect.set(selection.nativeHooks, field, safe + suffix);
    assert.throws(() => parseCentralBrainBinding(selection), /^Error: Native hook command binding is invalid$/);
  }
});

const notifyNode = 'C:\\Synthetic\\node.exe';
const notifyHook = 'C:\\Synthetic\\hooks\\codex-memory-notify.js';
const notifyWrapper = 'C:\\Synthetic\\OpenAI\\codex-computer-use.exe';
const ownedPrevious = JSON.stringify([notifyNode, notifyHook]);
test('Brain cutover detaches only owned predecessor while preserving OpenAI wrapper bytes', () => {
 const outer = [notifyWrapper, 'turn-ended', '--previous-notify', ownedPrevious];
 for (const newline of ['\n', '\r\n']) {
  const source = `notify = ${JSON.stringify(outer)} # keep-comment${newline}model = "keep"${newline}[other]${newline}keep = true${newline}`;
  const expected = source.replace(JSON.stringify(outer), JSON.stringify(outer.slice(0, 2)));
  assert.equal(configureMemoryNotify(source, notifyNode, notifyHook), expected);
 }
});
test('native literal TOML wrapper and Windows-normalized owned predecessor detach narrowly', () => {
 const previous = JSON.stringify(['c:/synthetic/NODE.EXE', 'c:/SYNTHETIC/hooks/codex-memory-notify.js']);
 const source = `notify = ['${notifyWrapper}', 'turn-ended', '--previous-notify', '${previous}'] # keep\nmodel = 'keep'\n`;
 assert.equal(configureMemoryNotify(source, notifyNode, notifyHook),
  `notify = ['${notifyWrapper}', 'turn-ended'] # keep\nmodel = 'keep'\n`);
});
test('custom, malformed, extra and unrecognized nested notify arrays remain byte-exact', () => {
 const cases:unknown[][] = [
  [notifyWrapper,'turn-ended','--previous-notify',JSON.stringify([notifyNode,'C:/Synthetic/custom.js'])],
  [notifyWrapper,'turn-ended','--previous-notify',JSON.stringify(['other-node',notifyHook])],
  [notifyWrapper,'turn-ended','--previous-notify',JSON.stringify([notifyNode,notifyHook,'extra'])],
  [notifyWrapper,'turn-ended','--previous-notify',JSON.stringify([notifyNode,null])],
  [notifyWrapper,'turn-ended','--previous-notify','not-json'],
  [notifyWrapper,'turn-ended','--previous-notify',ownedPrevious,'extra'],
  [notifyWrapper,'other-command','--previous-notify',ownedPrevious],
  [notifyWrapper,'turn-ended','other-flag',ownedPrevious],
  ['C:/Synthetic/other.exe','turn-ended','--previous-notify',ownedPrevious],
 ];
 for(const args of cases){const source=`notify = ${JSON.stringify(args)} # custom\nmodel = 'keep'\n`;
  assert.equal(configureMemoryNotify(source,notifyNode,notifyHook),source);}
});
test('direct owned notify still retires and custom direct notify remains intact', () => {
 const direct = `notify = ${JSON.stringify([notifyNode,notifyHook])}\nmodel = 'keep'\n`;
 assert.equal(configureMemoryNotify(direct,notifyNode,notifyHook),"\nmodel = 'keep'\n");
 const custom = `notify = ${JSON.stringify([notifyNode,'custom.js'])}\n`;
 assert.equal(configureMemoryNotify(custom,notifyNode,notifyHook),custom);
});

test("the retired Central Brain table keeps its historical tool timeout for block recognition", () => {
  const config = renderMcp({
    memoryProvider: "central-brain",
    mcpServers: [
      { name: "central-brain", transport: "stdio", command: "node", args: ["/synthetic/mcp.mjs"] },
      { name: "other", transport: "stdio", command: "node", args: ["/synthetic/other.mts"] },
    ],
  });
  const [brain, other] = config.split("[mcp_servers.other]");
  assert.match(brain, /tool_timeout_sec = 135\.0/);
  assert.match(brain, /startup_timeout_sec = 30\.0/);
  assert.match(other, /tool_timeout_sec = 60\.0/);
  assert.match(other, /startup_timeout_sec = 30\.0/);
});

test("unreadable selection shape fails safely instead of appearing absent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => resolveMemoryProvider(root), /^Error: Memory provider selection is invalid$/);
  const file = path.join(root, "selection.json");
  fs.writeFileSync(file, "{invalid selection}");
  assert.throws(() => resolveMemoryProvider(file), /^Error: Memory provider selection is invalid$/);
});
test('macOS Computer Use wrapper detaches an owned predecessor that names a Node path an upgrade removed', () => {
 // The notify line as the macOS Computer Use client writes it, slashes escaped (#55).
 const wrapper = '/Users/example/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient';
 const oldNode = '/opt/homebrew/Cellar/node/25.8.1_1/bin/node';
 const hook = '/Users/example/.codex/hooks/kherep-maestro/codex-memory-notify.js';
 const previous = JSON.stringify([oldNode, hook]).replace(/\//g, '\/');
 const source = `notify = ${JSON.stringify([wrapper, 'turn-ended', '--previous-notify', previous])}\nmodel = "keep"\n`;
 const expected = `notify = ${JSON.stringify([wrapper, 'turn-ended'])}\nmodel = "keep"\n`;
 assert.equal(configureMemoryNotify(source, '/opt/homebrew/bin/node', hook, [oldNode]), expected);
 // Without the old path in the list, nothing matches and the line stays byte-exact.
 assert.equal(configureMemoryNotify(source, '/opt/homebrew/bin/node', hook), source);
 // A different binary with the same arguments is not the wrapper.
 const other = source.replace('SkyComputerUseClient\"', 'OtherClient\"');
 assert.equal(configureMemoryNotify(other, '/opt/homebrew/bin/node', hook, [oldNode]), other);
});

// Issue #906: the notify assignment is found by a head expression and an index
// scan of its tail; the text it removes or rewrites is byte for byte the same.
test('notify removal keeps its extent: blank lines, comments, CRLF and no final line end', () => {
 const N = '/n/node', K = '/n/hook.mts', pair = `notify = ["${N}", "${K}"]`;
 const cases: [string, string][] = [
  [`model = 'x'\n\n\n${pair}\n\n\n[t]\n`, "model = 'x'\n\n\n[t]\n"],
  [`model = 'x'\n${pair}  # comment\n[t]\n`, "model = 'x'\n\n[t]\n"],
  [`model = 'x'\n${pair}\n# c\n[t]\n`, "model = 'x'\n\n[t]\n"],
  [`${pair} x\n`, `${pair} x\n`],
  ['notify = [1] # ]x\n', 'notify = [1] # ]x\n'],
  [`model = 'x'\r\n${pair}\r\n[t]\r\n`, "model = 'x'\r\n[t]\r\n"],
  [`model = 'x'\n${pair}`, "model = 'x'\n"],
 ];
 for (const [config, expected] of cases) assert.equal(configureMemoryNotify(config, N, K), expected, JSON.stringify(config));
 const wrapper = `notify = ["/Applications/Codex.app/SkyComputerUseClient", "turn-ended", "--previous-notify", ${JSON.stringify(JSON.stringify([N, K]))}  ]\n[t]\n`;
 assert.equal(configureMemoryNotify(wrapper, N, K), 'notify = ["/Applications/Codex.app/SkyComputerUseClient", "turn-ended"  ]\n[t]\n');
 for (const config of [`x = 1${'\n'.repeat(100_000)}`, `${'\n'.repeat(50_000)}notify = [${'] '.repeat(20_000)}x`]) {
  const started = performance.now();
  assert.equal(configureMemoryNotify(config, N, K), config);
  assert.ok(performance.now() - started < 200, 'linear on long blank runs');
 }
});
