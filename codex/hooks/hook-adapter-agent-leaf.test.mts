// The pin between the journal lib's AGENT_KEY and the agent ids the installed adapter and dispatcher accept. Neither
// holds a copy of the key, so this file fails on any change to the key, to either character set or to either's bounds.
// Ids run through each with its journal lib missing: an accepted id names the capture-failed marker as is.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";
import { dispatcherFixture } from "../../claude/hooks/guard-dispatch-fixture.mts";
import { AGENT_KEY } from "../../claude/hooks/lib/denial-journal.mts";
import { cleanupHomes, codexHome, run, shellPayload } from "./denials-fixture.mts";

const dispatcherRoots: string[] = [];
after(() => {
  cleanupHomes();
  for (const root of dispatcherRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const ALLOW = "process.exit(0);\n";
const ADAPTER = path.join(import.meta.dirname, "hook-adapter.mts");
const DISPATCHER = path.resolve(import.meta.dirname, "..", "..", "claude", "hooks", "guard-dispatch.mts");
interface Home { root: string; args: string[] }
const WRITERS: { label: string; source: string; install: () => Home }[] = [
  { label: "adapter", source: ADAPTER, install: () => {
    const home = codexHome({ "allow.mts": ALLOW }, "missing"), adapter = path.join(home.hookDir, "codex-hook-adapter.mts");
    declareCopy(ADAPTER, adapter);
    return { root: home.root, args: [adapter, path.join(home.hookDir, "allow.mts"), "pre"] };
  } },
  { label: "dispatcher", source: DISPATCHER, install: () => {
    const fx = dispatcherFixture("guard-dispatch-agent-leaf-"), guard = path.join(fx.hooks, "allow.mts");
    dispatcherRoots.push(fx.root);
    fs.writeFileSync(guard, ALLOW);
    return { root: fx.root, args: [fx.dispatch, guard] };
  } },
];
const call = async (home: Home, extra: Record<string, unknown>): Promise<void> => {
  const result = await run(home.args, shellPayload(extra));
  assert.equal(result.status, 0, result.stderr);
};
// The dispatcher fixture's fresh heartbeat is its own; anything else outside hooks is a write.
const FIXTURE_STATE = [".cache", path.join(".cache", "hook-integrity"), path.join(".cache", "hook-integrity", "heartbeat.json")];
const outsideHooks = (home: Home): string[] => fs.readdirSync(home.root, { recursive: true, encoding: "utf8" })
  .filter((name) => !name.startsWith("hooks") && !FIXTURE_STATE.includes(name));
const named = (id: string): string => `${JSON.stringify(id.slice(0, 12))} of length ${id.length}`;

test("AGENT_KEY is the key this file pins", () => {
  assert.deepEqual({ source: AGENT_KEY.source, flags: AGENT_KEY.flags }, { source: "^[A-Za-z0-9_-]{1,64}$", flags: "" });
});

for (const { label, source } of WRITERS) {
  test(`the ${label}'s character set is what AGENT_KEY accepts, over every UTF-16 code unit`, () => {
    const leaf = /\bAGENT_LEAF = "([^"]+)"/.exec(fs.readFileSync(source, "utf8"))?.[1];
    assert.ok(leaf, `${path.basename(source)} holds AGENT_LEAF`);
    let accepted = "";
    for (let unit = 0; unit <= 0xffff; unit++) if (AGENT_KEY.test(String.fromCharCode(unit))) accepted += String.fromCharCode(unit);
    assert.equal([...leaf].sort().join(""), accepted);
  });
}

test("AGENT_KEY accepts exactly the lengths 1 to 64", () => {
  for (let length = 0; length <= 256; length++) assert.equal(AGENT_KEY.test("x".repeat(length)), length >= 1 && length <= 64, `length ${length}`);
});

const ACCEPTED = ["A", "Z", "a", "z", "0", "9", "_", "-", "agent-c1", "A_z-9", "x".repeat(64),
  `${"ABCXYZabcxyz0189_-".repeat(3)}abcdefghij`];
for (const { label, install } of WRITERS) for (const id of ACCEPTED) {
  test(`${label}: id ${named(id)} writes its marker under its own name`, async () => {
    assert.match(id, AGENT_KEY);
    const home = install();
    await call(home, { agent_id: id });
    const dir = path.join(home.root, ".cache", "denied-calls");
    assert.deepEqual(fs.readdirSync(dir), [`${id}.failed`]);
    assert.equal(fs.readFileSync(path.join(dir, `${id}.failed`), "utf8"), "lib-load\n");
  });
}

const REJECTED = ["", "x".repeat(65), "@", "[", "`", "{", "/", ":", "^", "+", "a\n", "\na", "a b", ".", "..", "a.b", "../escape", "a/b", "a\\b", "a\0",
  "é", "K", "Ａ", "\ud83d", "\u{1F600}", "a\u{1F600}"];
for (const { label, install } of WRITERS) for (const id of REJECTED) {
  test(`${label}: id ${named(id)} writes nothing`, async () => {
    assert.doesNotMatch(id, AGENT_KEY);
    const home = install();
    await call(home, { agent_id: id });
    assert.deepEqual(outsideHooks(home), []);
  });
}

for (const { label, install } of WRITERS) {
  test(`${label}: no string id, or a SubagentHandback call, writes nothing`, async () => {
    const home = install();
    for (const extra of [{ agent_id: undefined }, { agent_id: 7 }, { agent_id: ["a"] }, { tool_name: "SubagentHandback" }]) await call(home, extra);
    assert.deepEqual(outsideHooks(home), []);
  });
}
