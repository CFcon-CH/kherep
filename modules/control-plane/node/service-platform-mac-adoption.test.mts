import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MacServiceAdapter } from "./service-platform-mac.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";

const uid = 1234, gid = 5678;

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mac-adoption-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), sourceRoot = path.join(root, "legacy source"), node = path.join(root, "bin", "node");
  fs.mkdirSync(home);
  const binding: ServiceBinding = {
    serviceName: "org.kherep.synthetic.adoption", platform: "darwin", workspace: root, configRoot: path.join(root, "config"),
    nodeExecutable: node, source: { root: sourceRoot, commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
  };
  const adapter = new MacServiceAdapter(path.join(root, "service"), home, uid, gid,
    () => assert.fail("unexpected native invocation"));
  const cli = path.join(sourceRoot, "modules", "control-plane", "node", "cli.mts");
  return { adapter, binding, home, node, sourceRoot, cli };
}

function snapshot(mac?: NativeServiceSnapshot["mac"]): NativeServiceSnapshot {
  return { definition: Buffer.from("synthetic plist"), security: Buffer.alloc(0), running: false, mac };
}

test("Mac legacy adoption resolves absolute executable and source paths and refuses malformed arguments", async t => {
  const { adapter, node, cli, sourceRoot } = fixture(t);
  const valid = snapshot({ ProgramArguments: [node, cli, "daemon"] });
  assert.equal(await adapter.adoptionNode(valid), node);
  assert.equal(await adapter.adoptionSourceRoot(valid), sourceRoot);

  for (const prior of [snapshot(), snapshot({ ProgramArguments: node }), snapshot({ ProgramArguments: [123, null] }),
    snapshot({ ProgramArguments: ["node", "modules/control-plane/node/cli.mts"] })]) {
    await assert.rejects(adapter.adoptionNode(prior), /LaunchAgent Node executable is unavailable/);
    await assert.rejects(adapter.adoptionSourceRoot(prior), /LaunchAgent legacy source root is unavailable/);
  }
  const wrongCli = snapshot({ ProgramArguments: [node, path.join(path.dirname(cli), "other.mts"), "daemon"] });
  await assert.rejects(adapter.adoptionSourceRoot(wrongCli), /LaunchAgent legacy source root is unavailable/);
});

test("Mac fresh security uses the configured owner and group with owner-only access and no ACL", async t => {
  const { adapter, binding } = fixture(t);
  const metadata = await adapter.freshSecurity(binding);
  assert.deepEqual(JSON.parse(metadata.toString("utf8")), { uid, gid, mode: 0o600, acl: "absent" });
});

test("Mac write refuses unsafe backup metadata before creating LaunchAgents or calling native commands", async t => {
  const { adapter, binding, home } = fixture(t);
  const expected = { uid, gid, mode: 0o600, acl: "absent" };
  for (const change of [{ uid: uid + 1 }, { gid: gid + 1 }, { mode: 0o620 }, { mode: 0o602 }, { acl: "present" }, { acl: undefined }]) {
    const metadata = Buffer.from(JSON.stringify({ ...expected, ...change }));
    await assert.rejects(adapter.write(binding, Buffer.from("synthetic plist"), metadata), /LaunchAgent security metadata is unsafe/);
    assert.deepEqual(fs.readdirSync(home), []);
  }
});
