import assert from "node:assert/strict";
import { test } from "node:test";

import { decision } from "./acceptance-gate.mts";

test("trailing separator runs preserve scope and sibling refusal", () => {
  const env = { KHEREP_WORKSPACE: "D:/Work///" };
  assert.ok(decision({ cwd: "D:/Work/app///", last_assistant_message: "Done." }, env));
  assert.equal(decision({ cwd: "D:/Work-copy///", last_assistant_message: "Done." }, env), null);
});

test("blocks Kherep completion claims without an acceptance receipt", () => {
  const result = decision({ cwd: "D:\\Work\\app", last_assistant_message: "Fertig." }, { KHEREP_WORKSPACE: "D:\\Work" });
  assert.ok(result);
  assert.equal(result.continue, false);
  assert.match(result.stopReason, /C1-C4/);
});

test("fails open for receipts and payloads without an assistant message", () => {
  assert.equal(decision({ cwd: "D:\\Work", last_assistant_message: "Done. C1 ok C2 ok C3 ok C4 ok" }, { KHEREP_WORKSPACE: "D:\\Work" }), null);
  assert.equal(decision({ cwd: "D:\\Work" }, { KHEREP_WORKSPACE: "D:\\Work" }), null);
});

test("uses the neutral default workspace and ignores unrelated worker paths", () => {
  assert.ok(decision(
    { cwd: "/Users/example/Kherep/app", last_assistant_message: "Done." },
    { HOME: "/Users/example" },
  ));
  assert.equal(decision(
    { cwd: "/work/worker/app", last_assistant_message: "Done." },
    { HOME: "/Users/example" },
  ), null);
});
