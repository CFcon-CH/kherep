import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";

// Only generated budgets and owned bounded children. Pauses cover the actual
// read, final rename and exact-token release of production takeTurn.
for (const route of ["legacy", "group"]) for (const seam of ["snapshot", "rename", "release"]) test(`live writer cannot be displaced by ${route} at ${seam}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "budget-concurrency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "config", "cache", "tmp"]) fs.mkdirSync(path.join(root, name));
  const paths = nodePaths(path.join(root, "config")), owner = "synthetic-owner";
  const file = path.join(paths.dir, "listeners", `${owner}.turns.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"turns":[]}');
  const ready = path.join(root, "ready"), release = path.join(root, "release");
  const env = { PATH: process.env.PATH ?? "", HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: path.join(root, "tmp") };
  const script = `import fs from 'node:fs'; import {takeTurn} from ${JSON.stringify(new URL("./autonomy.mts", import.meta.url).href)};
import {debitGroup} from ${JSON.stringify(new URL("./budget-store.mts", import.meta.url).href)};
const [mode, seam, p, owner, file, ready, release] = process.argv.slice(1);
let paused = false;
function pause(){ if(paused || mode!=='A')return; paused=true; fs.writeFileSync(ready,'ready');
const until=Date.now()+8000; while(!fs.existsSync(release)){if(Date.now()>until)throw Error('fixture deadline');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
const read=fs.readFileSync, rename=fs.renameSync;
fs.readFileSync=function(...args){const result=read.apply(this,args);if(args[0]===file && seam==='snapshot')pause();
if(args[0]===file+'.lock' && seam==='release' && read(file,'utf8').includes('1767225600000'))pause();return result;};
fs.renameSync=function(...args){if(args[1]===file && seam==='rename')pause();return rename.apply(this,args);};
const budget={perHour:1,perDay:1,spacingMs:30000};
process.stdout.write(mode==='B' && ${JSON.stringify(route)}==='group' ? debitGroup(file,
{groupId:'00000000-0000-4000-8000-000000000706',reservationId:'00000000-0000-4000-8000-000000000707',groupFingerprint:'a'.repeat(64)},1767225600000,budget).status
: takeTurn(JSON.parse(p),owner,1767225600000,budget));`;
  const run = (mode: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, mode, seam, JSON.stringify(paths), owner, file, ready, release],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", x => { output += x; }); child.stderr.on("data", x => { error += x; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const done = new Promise<string>((resolve, reject) => {
      child.on("error", reject); child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(Error(error)); });
    });
    return { child, done };
  };
  const a = run("A");
  try {
    const until = Date.now() + 5000;
    while (!fs.existsSync(ready)) { if (Date.now() > until) throw Error("readiness deadline"); await new Promise(r => setTimeout(r, 5)); }
    assert.equal(a.child.exitCode, null);
    const aged = (Date.now() - 60_000) / 1000; fs.utimesSync(`${file}.lock`, aged, aged);
    const b = await run("B").done;
    assert.equal(b, "locked", "a live owner, including a suspended snapshot writer, fences B regardless of mtime");
  } finally { fs.writeFileSync(release, "release"); assert.equal(await a.done, "ok"); }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).turns, [1767225600000]);
});
