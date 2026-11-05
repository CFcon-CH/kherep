import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import { makeEnvelope } from "../protocol.mts";
import { codexIntakeWindow } from "./codex-intake-window.mts";
import type { NodeClient } from "./client.mts";
import { nodePaths } from "./config.mts";
import { DEFAULT_POLICY, readPolicy } from "./policy.mts";

for (const scenario of ["progress", "retained-admission", "refresh", "excluded", "drift", "missing", "malformed", "close", "stop", "drain", "admitted-drift", "publication", "counter"]) {
  test(`held Codex intake: ${scenario}`, () => {
    const result = execFileSync(process.execPath, ["--experimental-test-module-mocks",
      path.join(import.meta.dirname, "codex-intake-window-fixture.mts"), scenario], { encoding: "utf8", timeout: 15_000 });
    assert.match(result, /INTAKE_WINDOW_PASS/);
  });
}

test("required policy reads distinguish missing/error from the existing default", () => {
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".intake-policy-"));
  const file = path.join(root, "policy.json");
  try {
    assert.deepEqual(readPolicy(file), DEFAULT_POLICY);
    assert.equal(readPolicy(file, true), null);
    assert.equal(readPolicy(root, true), null);
    fs.writeFileSync(file, "{");
    assert.equal(readPolicy(file, true), null);
    fs.writeFileSync(file, JSON.stringify(DEFAULT_POLICY));
    assert.deepEqual(readPolicy(file, true), DEFAULT_POLICY);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Issue #493 D2: a frame admitted, then made ineligible before its callback runs,
// is deferred and never counted by the window (handled() runs after eligible()).
for (const invalidation of ["close", "disconnect", "auth", "policy"]) {
  test(`admitted then invalidated by ${invalidation}: handled 0, deferred 2`, async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dirname, ".intake-deferred-"));
    const policyFile = path.join(root, "policy.json");
    try {
      fs.writeFileSync(policyFile, JSON.stringify({ version: 1, allowedCommands: [] }));
      let connected = true;
      const counts = { handled: 0, deferred: 0, onFrame: 0, errors: 0 };
      const arrival = { monoMs: 17, wallMs: 1234, kind: 4 };
      const client = { authenticated: true, onFrame: async () => { counts.onFrame++; return []; } };
      const window = codexIntakeWindow({ client: client as unknown as NodeClient, paths: nodePaths(root), policyFile,
        policy: readPolicy(policyFile, true)!, connected: () => connected, send: () => true, exchange: () => {}, queue: () => {},
        defer: (_data, original) => { assert.equal(original, arrival); counts.deferred++; }, handled: () => { counts.handled++; }, log: () => { counts.errors++; } });
      for (let n = 1; n <= 2; n++) {
        assert.equal(window.frame(JSON.stringify(makeEnvelope("message.status",
          { messageId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, state: "accepted" }, n, 0)), arrival), true);
      }
      if (invalidation === "close") window.close();
      if (invalidation === "disconnect") connected = false;
      if (invalidation === "auth") client.authenticated = false;
      if (invalidation === "policy") fs.writeFileSync(policyFile, JSON.stringify({ version: 2 }));
      await new Promise<void>((resolve) => setImmediate(resolve)); // the callbacks run before drain closes the window
      await window.drain();
      assert.deepEqual(counts, { handled: 0, deferred: 2, onFrame: 0, errors: 0 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
