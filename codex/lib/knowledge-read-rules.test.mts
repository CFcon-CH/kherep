import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { install } from "../install.mts";
import type { Capabilities } from "./contracts.mts";
import { starlarkString } from "./control-plane-rules.mts";
import { fixtureModelOptions } from "./model-policy.fixture.mts";
import { KNOWLEDGE_READ_RULES_FILE, knowledgeReadRulesPath, renderKnowledgeReadRules } from "./knowledge-read-rules.mts";

const MAC_WORKSPACE = "/Users/a/Work Projects";
const WINDOWS_WORKSPACE = String.raw`C:\Users\a\Work Projects`;
const OTHER_VERBS = ["create", "update", "delete", "purge", "labels", "move", "stitch", "related"];

test("the managed rule allows exactly search/get at the forward-slash workspace broker path", () => {
  const rules = renderKnowledgeReadRules(WINDOWS_WORKSPACE);
  assert.equal(KNOWLEDGE_READ_RULES_FILE, "kherep-knowledge-read.rules");
  assert.equal(knowledgeReadRulesPath("/codex"), path.join("/codex", "rules", KNOWLEDGE_READ_RULES_FILE));
  assert.match(rules, /^# Managed by Kherep .*Rewritten on every install/m);
  assert.equal(rules.split("prefix_rule(").length - 1, 1);
  assert.ok(rules.includes('pattern = ["node", "C:/Users/a/Work Projects/tools/atl-confluence.mts", ["search", "get"]],'));
  assert.ok(rules.includes('decision = "allow",'));
  assert.match(rules, /justification = .*read-only knowledge lookup/);
  for (const verb of ["search", "get", ...OTHER_VERBS]) {
    assert.ok(rules.includes(starlarkString(`node "C:/Users/a/Work Projects/tools/atl-confluence.mts" ${verb}`)), verb);
  }
  assert.ok(rules.includes("atl-confluence-ccoder.mts"));
});

test("rendering escapes literal quotes and rejects control characters through starlarkString", () => {
  const rules = renderKnowledgeReadRules('/work/a"b');
  assert.ok(rules.includes(starlarkString('/work/a"b/tools/atl-confluence.mts')));
  for (const control of ["\u0000", "\t", "\n", "\r", "\u001f", "\u007f"]) {
    assert.throws(() => renderKnowledgeReadRules(`/work/a${control}b`), /Control characters/);
  }
});

const codexAvailable = spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
for (const [platform, workspace, broker] of [
  ["macOS", MAC_WORKSPACE, `${MAC_WORKSPACE}/tools/atl-confluence.mts`],
  ["Windows path on current host", WINDOWS_WORKSPACE, "C:/Users/a/Work Projects/tools/atl-confluence.mts"],
] as const) {
  test(`execpolicy checks the ${platform} rule without allowing other verbs or compound commands`, { skip: !codexAvailable && "codex is not on PATH" }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-knowledge-policy-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, KNOWLEDGE_READ_RULES_FILE);
    fs.writeFileSync(file, renderKnowledgeReadRules(workspace));
    for (const [args, allowed] of [
      [["node", broker, "search", "--space", "KB", "--query", "rules"], true],
      [["node", broker, "get", "--id", "123"], true],
      ...OTHER_VERBS.map((verb) => [["node", broker, verb], false] as const),
      [["node", broker.replace("atl-confluence.mts", "atl-confluence-ccoder.mts"), "search"], false],
      [["zsh", "-lc", `x && node "${broker}" search`], false],
      [["x", "&&", "node", broker, "search"], false],
    ] as const) {
      const result = spawnSync("codex", ["execpolicy", "check", "--rules", file, "--", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout) as { decision?: string };
      assert.equal(output.decision === "allow", allowed, JSON.stringify(args));
    }
  });
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-knowledge-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "home", ".codex");
  const claudeRegistryFile = path.join(root, "home", ".claude.json");
  fs.mkdirSync(codexHome, { recursive: true });
  const capabilities = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "parity", "capabilities.json"), "utf8")) as Capabilities;
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: Object.fromEntries(
    capabilities.mcpServers.map((name) => [name, { type: "http", url: `https://example.test/${name}` }])) }), { mode: 0o600 });
  const options = {
    ...fixtureModelOptions(), codexHome, claudeRegistryFile,
    claudeConfigDir: path.join(root, "home", ".claude"), workspace: path.join(root, "workspace"),
    nodePath: process.execPath, log: (): void => {}, skipPluginRegistration: true, installAtlassianTools: false,
    resolveRegistryRuntime: () => "fixture", runCodex: (): string => "ok",
    controlPlaneOutbox: path.join(root, "kherep config", "control-plane", "outbox"),
  };
  return { root, codexHome, options };
}

test("install writes and rewrites the rule for the broker it installs and preserves operator rules", (t) => {
  const { codexHome, options } = fixture(t);
  const operatorFile = path.join(codexHome, "rules", "operator.rules");
  fs.mkdirSync(path.dirname(operatorFile), { recursive: true });
  const operator = Buffer.from("# operator rules\r\n");
  fs.writeFileSync(operatorFile, operator);
  const ruleFile = knowledgeReadRulesPath(codexHome);
  install(options);
  assert.ok(fs.existsSync(path.join(options.workspace, "tools", "atl-confluence.mts")));
  assert.equal(fs.readFileSync(ruleFile, "utf8"), renderKnowledgeReadRules(options.workspace));
  fs.writeFileSync(ruleFile, "# hand edited\n");
  install(options);
  assert.equal(fs.readFileSync(ruleFile, "utf8"), renderKnowledgeReadRules(options.workspace));
  assert.deepEqual(fs.readFileSync(operatorFile), operator);
});

test("install without an explicit workspace binds the rule to the default workspace broker", (t) => {
  const { root, codexHome, options } = fixture(t);
  const homeDir = path.join(root, "default-home");
  const priorWorkspace = process.env.KHEREP_WORKSPACE;
  delete process.env.KHEREP_WORKSPACE;
  try {
    install({ ...options, workspace: undefined, homeDir });
    const workspace = path.join(homeDir, "Kherep");
    assert.ok(fs.existsSync(path.join(workspace, "tools", "atl-confluence.mts")));
    assert.equal(fs.readFileSync(knowledgeReadRulesPath(codexHome), "utf8"), renderKnowledgeReadRules(workspace));
  } finally {
    if (priorWorkspace === undefined) delete process.env.KHEREP_WORKSPACE;
    else process.env.KHEREP_WORKSPACE = priorWorkspace;
  }
});

test("failure while copying the broker leaves the knowledge rule absent", (t) => {
  const { codexHome, options } = fixture(t);
  const broker = path.join(options.workspace, "tools", "atl-confluence.mts");
  assert.throws(() => install({ ...options, afterWrite: () => {
    if (fs.existsSync(broker)) throw new Error("synthetic broker copy failure");
  } }), /synthetic broker copy failure/);
  assert.equal(fs.existsSync(knowledgeReadRulesPath(codexHome)), false);
  assert.equal(fs.existsSync(broker), false);
});

for (const prior of [undefined, "# prior managed rule\r\n"]) {
  test(`rollback ${prior === undefined ? "removes a new" : "restores an existing"} knowledge rule after a later write fails`, (t) => {
    const { codexHome, options } = fixture(t);
    const ruleFile = knowledgeReadRulesPath(codexHome);
    if (prior !== undefined) {
      fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
      fs.writeFileSync(ruleFile, prior);
    }
    let sawRule = false;
    assert.throws(() => install({ ...options, afterWrite: () => {
      if (fs.existsSync(ruleFile) && fs.readFileSync(ruleFile, "utf8") !== prior) {
        sawRule = true;
        throw new Error("synthetic failure after knowledge rule write");
      }
    } }), /synthetic failure after knowledge rule write/);
    assert.equal(sawRule, true);
    if (prior === undefined) assert.equal(fs.existsSync(ruleFile), false);
    else assert.equal(fs.readFileSync(ruleFile, "utf8"), prior);
    assert.equal(fs.existsSync(path.join(options.workspace, "tools", "atl-confluence.mts")), false);
  });
}
