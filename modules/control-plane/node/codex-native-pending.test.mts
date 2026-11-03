import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { releaseNativeOwner, reserveNativeOwner } from "./codex-native-pending.mts";
import { nativeReconcileFixture as fixture, OWNER, id } from "./codex-native-reconcile-fixture.mts";
import { reconcileNativeQueues } from "./codex-native-reconcile.mts";
import { taskNode } from "./task-fixture.mts";

const pendingFile = (paths: {dir: string}): string => path.join(paths.dir, "codex-native-pending", `${OWNER}.json`);

test("separate processes atomically reserve exactly one immutable native owner group", async t => {
  const f = taskNode(t), script = `import { reserveNativeOwner } from ${JSON.stringify(new URL("./codex-native-pending.mts", import.meta.url).href)};
    try { console.log(reserveNativeOwner(JSON.parse(process.argv[1]), process.argv[2], [process.argv[3]])); }
    catch (e) { if (!/native owner mutation held/.test(e.message)) throw e; console.log(false); }`;
  const run = (messageId: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(f.paths), OWNER, messageId], { windowsHide: true });
    let out = "", err = ""; child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("error", reject); child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err)); });
  });
  assert.deepEqual((await Promise.all([run(id(1)), run(id(2))])).sort(), ["false", "true"]);
  const before = fs.readFileSync(pendingFile(f.paths), "utf8");
  assert.equal(reserveNativeOwner(f.paths, OWNER, [id(3)]), false);
  assert.equal(fs.readFileSync(pendingFile(f.paths), "utf8"), before);
});

test("restart reconstructs outstanding groups and exact cleanup alone permits the next reservation", async t => {
  const f = fixture(t, 2);
  assert.equal(reserveNativeOwner(f.paths, OWNER, [id(3)]), false);
  const before = fs.readFileSync(pendingFile(f.paths), "utf8");
  const list = f.client.list;
  f.client.list = async () => ({ data: f.rows(), nextCursor: "incomplete" });
  await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
  assert.equal(fs.readFileSync(pendingFile(f.paths), "utf8"), before);
  assert.equal(reserveNativeOwner(f.paths, OWNER, [id(3)]), false);
  f.client.list = list;
  await reconcileNativeQueues(f.paths, OWNER, { open: f.open });
  assert.equal(fs.existsSync(pendingFile(f.paths)), false);
  assert.equal(reserveNativeOwner(f.paths, OWNER, [id(3)]), true);
});

test("uncertain, incomplete, malformed and reserved-before-attempt histories never authorize a duplicate", async t => {
  for (const kind of ["uncertain", "attempted", "malformed", "partial"] as const) await t.test(kind, async sub => {
    const f = fixture(sub, 2), file = f.attempt(id(2));
    const row = JSON.parse(fs.readFileSync(file, "utf8"));
    if (kind === "malformed") fs.writeFileSync(file, "{");
    else if (kind === "partial") fs.unlinkSync(file);
    else fs.writeFileSync(file, JSON.stringify({ ...row, state: kind, queueId: undefined }));
    let allowed = false;
    try { allowed = reserveNativeOwner(f.paths, OWNER, [id(3)]); } catch { /* unknown remains fenced */ }
    assert.equal(allowed, false);
  });
  const f = taskNode(t);
  assert.equal(reserveNativeOwner(f.paths, OWNER, [id(1)]), true);
  await reconcileNativeQueues(f.paths, OWNER);
  assert.equal(reserveNativeOwner(f.paths, OWNER, [id(2)]), false);
});


test("release without a reservation leaves absent storage absent", t => {
  const f = taskNode(t), directory = path.dirname(pendingFile(f.paths));
  assert.equal(fs.existsSync(directory), false);
  releaseNativeOwner(f.paths, OWNER);
  assert.equal(fs.existsSync(directory), false);
});

test("release without an owner file preserves existing storage and foreign records", t => {
  const f = taskNode(t), directory = path.dirname(pendingFile(f.paths));
  fs.mkdirSync(directory);
  const foreign = path.join(directory, "01a121f0-d3b1-7383-852c-b4405eae3162.json");
  fs.writeFileSync(foreign, "synthetic foreign reservation");
  const before = fs.readdirSync(directory);
  releaseNativeOwner(f.paths, OWNER);
  assert.deepEqual(fs.readdirSync(directory), before);
  assert.equal(fs.readFileSync(foreign, "utf8"), "synthetic foreign reservation");
});

test("release preserves malformed and unreadable reservations fail closed", async t => {
  for (const kind of ["malformed", "unreadable"] as const) await t.test(kind, sub => {
    const f = taskNode(sub), file = pendingFile(f.paths);
    assert.equal(reserveNativeOwner(f.paths, OWNER, [id(1)]), true);
    if (kind === "malformed") fs.writeFileSync(file, "{");
    const before = fs.readFileSync(file);
    if (kind === "unreadable") {
      const read = fs.readFileSync;
      sub.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (String(target) === file) throw Object.assign(new Error("synthetic unreadable reservation"), { code: "EACCES" });
        return Reflect.apply(read, fs, [target, ...args]);
      }) as typeof fs.readFileSync);
    }
    assert.throws(() => releaseNativeOwner(f.paths, OWNER));
    sub.mock.restoreAll();
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(reserveNativeOwner(f.paths, OWNER, [id(2)]), false);
  });
});
