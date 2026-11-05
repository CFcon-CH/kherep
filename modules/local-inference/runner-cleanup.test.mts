import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run, type Runtime } from "./runner.mts";

test("artifact cleanup keeps its existing error precedence and ignores only ENOENT", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runner-cleanup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime: Runtime = {
    platform: "darwin",
    env: { HOME: root, KHEREP_WORKSPACE: root, KHEREP_LOCAL_OUTPUT_ROOT: root },
    config: { schemaVersion: 2, backends: { mac: {
      engine: "LM Studio", endpoint: "http://127.0.0.1:1234/v1", model: "synthetic-model",
    } }, profiles: { mac: { backends: { mac: { transport: "local" } } } } },
    requestJson: async (url) => url.endsWith("/models") ? { data: [{ id: "synthetic-model" }] }
      : { choices: [{ message: { content: "synthetic public response" } }] },
  };
  const rename = fs.renameSync, unlink = fs.unlinkSync;
  try {
    for (const code of [undefined, "ENOENT", "EACCES"]) {
      const writeFailure = new Error("synthetic rename failure");
      const cleanupFailure = Object.assign(new Error("synthetic cleanup failure"), { code });
      fs.renameSync = () => { throw writeFailure; };
      fs.unlinkSync = (file) => {
        if (code) throw cleanupFailure;
        unlink(file);
      };
      await assert.rejects(run(["--backend", "mac", "--public", "--task", "Synthetic cleanup check"], runtime),
        (error: unknown) => error === (code === "EACCES" ? cleanupFailure : writeFailure));
    }
    fs.renameSync = rename;
    fs.unlinkSync = unlink;
    const result = await run(["--backend", "mac", "--public", "--task", "Synthetic cleanup check"], runtime);
    assert.equal(result.status, "ok");
    assert.ok(fs.existsSync(result.artifact));
  } finally { fs.renameSync = rename; fs.unlinkSync = unlink; }
});
