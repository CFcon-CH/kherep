// The pin between protocol-messages.mts isMessageId and the id exactInbox accepts for --message-id. exactInbox holds no
// copy of the UUID pattern, so this file fails on any change to the pattern, to messageIdLeaf's character set or to its shape.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isMessageId } from "../protocol-messages.mts";
import { nodePaths } from "./config.mts";
import { runMsg } from "./msg-cli.mts";
import { messageIdLeaf } from "./msg-inbox-exact.mts";

const ID = "019a0000-0000-7000-8000-000000000005";
const OTHER = "019a0000-0000-7000-8000-000000000001";
const same = (value: unknown, why: string): void => {
  assert.equal(messageIdLeaf(value), isMessageId(value) ? value : "", why);
};

test("UUID is the pattern this file pins", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "protocol-messages.mts"), "utf8");
  assert.equal(/^const UUID = (\/.+\/[a-z]*);$/m.exec(source)?.[1], "/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/");
});

test("messageIdLeaf agrees with isMessageId for every UTF-16 code unit at every position", () => {
  for (let at = 0; at < ID.length; at++) for (let unit = 0; unit <= 0xffff; unit++) {
    same(`${ID.slice(0, at)}${String.fromCharCode(unit)}${ID.slice(at + 1)}`, `position ${at}, unit ${unit}`);
  }
});

test("messageIdLeaf agrees with isMessageId for every group length and total length", () => {
  const groups = ID.split("-");
  groups.forEach((group, index) => {
    for (let length = 0; length <= group.length + 2; length++) {
      same(groups.map((other, at) => at === index ? "a".repeat(length) : other).join("-"), `group ${index}, length ${length}`);
    }
  });
  for (let length = 0; length <= 72; length++) {
    for (const fill of ["0", "f", "-"]) same(fill.repeat(length), `${fill} of length ${length}`);
    same(`${ID}${ID}`.slice(0, length), `prefix of length ${length}`);
  }
});

test("messageIdLeaf returns an accepted id byte for byte, and no other input", () => {
  assert.equal(messageIdLeaf(ID), ID);
  assert.equal(messageIdLeaf("00000000-0000-0000-0000-000000000000"), "00000000-0000-0000-0000-000000000000");
  assert.equal(messageIdLeaf("ffffffff-ffff-ffff-ffff-ffffffffffff"), "ffffffff-ffff-ffff-ffff-ffffffffffff");
  const rejected = ["", ID.toUpperCase(), `${ID}\n`, `\n${ID}`, ` ${ID}`, `${ID}/`, ID.replaceAll("-", ""), ID.replaceAll("-", "_"),
    `../${ID.slice(3)}`, `${ID.slice(0, 35)}\0`, `${ID.slice(0, 35)}é`, `${ID.slice(0, 35)}K`, `${ID.slice(0, 34)}\u{1F600}`, `${ID.slice(0, 35)}\ud83d`];
  for (const value of rejected) { assert.equal(isMessageId(value), false, JSON.stringify(value)); assert.equal(messageIdLeaf(value), "", JSON.stringify(value)); }
  for (const value of [undefined, null, 7, true, [ID], { id: ID }]) { assert.equal(isMessageId(value), false); assert.equal(messageIdLeaf(value), ""); }
});

for (const id of [ID.toUpperCase(), `${ID}\n`, ID.replaceAll("-", "_"), `../${ID.slice(3)}`, `${ID.slice(0, 35)}é`, "x".repeat(36), ""]) {
  test(`--message-id ${JSON.stringify(id.slice(0, 12))} of length ${id.length} is refused with no lock file`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-exact-leaf-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = nodePaths(root), err: string[] = [], out: string[] = [];
    fs.mkdirSync(paths.inbox, { recursive: true });
    const code = await runMsg(["inbox", `--message-id=${id}`, "--from", OTHER, "--expect-node", OTHER, "--expect-session", OTHER,
      "--expect-target-session", OTHER, "--expect-reply-to", OTHER, "--expect-text-sha256", "0".repeat(64)],
    { paths, env: { CODEX_THREAD_ID: OTHER }, out: (line) => out.push(line), err: (line) => err.push(line) });
    assert.deepEqual({ code, out, err }, { code: 1, out: [], err: ["kherep-node msg: exact-inbox-invalid-selectors"] });
    assert.deepEqual(fs.readdirSync(paths.inbox), []);
  });
}
