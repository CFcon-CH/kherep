import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { recordLockFile } from "./inbox-record-lock.mts";
import { targetFixture, TARGET_OWNER } from "./target-delivery-fixture.mts";

test("owned competing processes reclaim one dead owner and reserve only one immutable group", async t => {
  const f = targetFixture(t), dir = path.join(f.paths.dir, "codex-native-pending"); fs.mkdirSync(dir);
  // This PID was obtained only from an owned child that has reached terminal exit.
  const ended = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 5000 });
  assert.equal(ended.status, 0);
  const lock = recordLockFile(dir, TARGET_OWNER);
  fs.writeFileSync(lock, JSON.stringify({ version: 1, pid: Number(ended.stdout), startedAt: new Date(0).toISOString(), owner: "synthetic-dead-acquisition" }));
  const script = `import {reserveTargetOwner} from ${JSON.stringify(new URL("./codex-native-pending.mts", import.meta.url).href)};
    try {console.log(reserveTargetOwner(JSON.parse(process.argv[1]),JSON.parse(process.argv[2])) ? 'reserved' : 'fenced');}
    catch(e) {if(!/native owner mutation held/.test(e.message))throw e;console.log('fenced');}`;
  const run = () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(f.paths), JSON.stringify(f.group)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = ""; child.stdout.on("data", x => { output += x; }); child.stderr.on("data", x => { error += x; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    return new Promise<string>((resolve, reject) => { child.on("error", reject); child.on("close", code => {
      clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(Error(error));
    }); });
  };
  assert.deepEqual((await Promise.all([run(), run()])).sort(), ["fenced", "reserved"]);
  const saved = JSON.parse(fs.readFileSync(f.reservation, "utf8"));
  assert.deepEqual(saved.group, f.group); assert.equal(saved.phase, "reserved"); assert.equal(fs.existsSync(`${f.reservation}.lock`), false);
});
