// The pin between the journal lib's AGENT_KEY and the agent ids an installed adapter accepts. The adapter holds no
// copy of the key, so this file fails on any change to the key, to the adapter's character set or to its bounds.
// Ids run through the adapter with its journal lib missing: an accepted id names the capture-failed marker as is.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";
import { AGENT_KEY } from "../../claude/hooks/lib/denial-journal.mts";
import { cleanupHomes, codexHome, run, shellPayload, type CodexHome } from "./denials-fixture.mts";

after(cleanupHomes);

const ADAPTER = path.join(import.meta.dirname, "hook-adapter.mts");
const installed = (): CodexHome => {
  const home = codexHome({ "allow.mts": "process.exit(0);\n" }, "missing");
  declareCopy(ADAPTER, path.join(home.hookDir, "codex-hook-adapter.mts"));
  return home;
};
const adapt = async (home: CodexHome, extra: Record<string, unknown>): Promise<void> => {
  const result = await run([path.join(home.hookDir, "codex-hook-adapter.mts"), path.join(home.hookDir, "allow.mts"), "pre"], shellPayload(extra));
  assert.equal(result.status, 0, result.stderr);
};
const outsideHooks = (home: CodexHome): string[] => fs.readdirSync(home.root, { recursive: true, encoding: "utf8" })
  .filter((name) => !name.startsWith("hooks"));
const named = (id: string): string => `${JSON.stringify(id.slice(0, 12))} of length ${id.length}`;

test("AGENT_KEY is the key this file pins", () => {
  assert.deepEqual({ source: AGENT_KEY.source, flags: AGENT_KEY.flags }, { source: "^[A-Za-z0-9_-]{1,64}$", flags: "" });
});

test("the adapter's character set is what AGENT_KEY accepts, over every UTF-16 code unit", () => {
  const leaf = /const AGENT_LEAF = "([^"]+)"/.exec(fs.readFileSync(ADAPTER, "utf8"))?.[1];
  assert.ok(leaf, "hook-adapter.mts holds AGENT_LEAF");
  let accepted = "";
  for (let unit = 0; unit <= 0xffff; unit++) if (AGENT_KEY.test(String.fromCharCode(unit))) accepted += String.fromCharCode(unit);
  assert.equal([...leaf].sort().join(""), accepted);
});

test("AGENT_KEY accepts exactly the lengths 1 to 64", () => {
  for (let length = 0; length <= 256; length++) assert.equal(AGENT_KEY.test("x".repeat(length)), length >= 1 && length <= 64, `length ${length}`);
});

const ACCEPTED = ["A", "Z", "a", "z", "0", "9", "_", "-", "agent-c1", "A_z-9", "x".repeat(64),
  `${"ABCXYZabcxyz0189_-".repeat(3)}abcdefghij`];
for (const id of ACCEPTED) {
  test(`id ${named(id)} writes its marker under its own name`, async () => {
    assert.match(id, AGENT_KEY);
    const home = installed();
    await adapt(home, { agent_id: id });
    const dir = path.join(home.root, ".cache", "denied-calls");
    assert.deepEqual(fs.readdirSync(dir), [`${id}.failed`]);
    assert.equal(fs.readFileSync(path.join(dir, `${id}.failed`), "utf8"), "lib-load\n");
  });
}

const REJECTED = ["", "x".repeat(65), "@", "[", "`", "{", "/", ":", "^", "+", "a\n", "\na", "a b", ".", "..", "a.b", "../escape", "a/b", "a\\b", "a\0",
  "é", "K", "Ａ", "\ud83d", "\u{1F600}", "a\u{1F600}"];
for (const id of REJECTED) {
  test(`id ${named(id)} writes nothing`, async () => {
    assert.doesNotMatch(id, AGENT_KEY);
    const home = installed();
    await adapt(home, { agent_id: id });
    assert.deepEqual(outsideHooks(home), []);
  });
}

test("no string id, or a SubagentHandback call, writes nothing", async () => {
  const home = installed();
  for (const extra of [{ agent_id: undefined }, { agent_id: 7 }, { agent_id: ["a"] }, { tool_name: "SubagentHandback" }]) await adapt(home, extra);
  assert.deepEqual(outsideHooks(home), []);
});
