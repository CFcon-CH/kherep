// Issue #780. The broker's writer of the Kherep attribution log: one push record
// after a verified branch.push. The pre-push hook stands down on KHEREP_BROKER_PUSH,
// so the broker is the single writer for its own pushes. The projection admits
// only node: imports here, so configRoot, markerKey, the marker take, the
// session-id rule and the 90-day trim are copies of modules/control-plane/node/
// config.mts and attribution.mts; bootstrap/pre-push-hook.test.mts pins them.
// A record names ids, paths, refs and the SHA: no URL, token, operationId or bot.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runtime } from './contract.mts';
const RETENTION_MS=90*24*60*60_000, MARKER_MS=120_000;
const SESSION_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export type PushSession = {sessionId:string; sessionSource:string};
/** Copy of configRoot in modules/control-plane/node/config.mts. */
export function configRoot(env:NodeJS.ProcessEnv=process.env, platform:NodeJS.Platform=process.platform):string {
  if (env.KHEREP_CONFIG_DIR) return path.resolve(env.KHEREP_CONFIG_DIR);
  if (platform==='win32') return path.join(env.APPDATA ?? path.join(os.homedir(),'AppData','Roaming'),'kherep');
  if (platform==='darwin') return path.join(os.homedir(),'Library','Application Support','kherep');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(),'.config'),'kherep');
}
/** Copy of markerKey in attribution.mts. */
export function markerKey(toplevel:string, platform:NodeJS.Platform=process.platform):string {
  const normalized=toplevel.replace(/\\/g,'/').replace(/(?<!\/)\/+$/,'');
  return crypto.createHash('sha256').update(platform==='win32'?normalized.toLowerCase():normalized).digest('hex');
}
// Reads and removes the marker for <toplevel>; only a fresh, valid one of this runtime counts.
function takeMarker(dir:string, runtime:Runtime, toplevel:string, now:number):PushSession|null {
  const file=path.join(dir,'attribution','pending',`${markerKey(toplevel)}.json`);
  let marker:{sessionId?:unknown; runtime?:unknown; at?:unknown};
  try {marker=JSON.parse(fs.readFileSync(file,'utf8'));fs.rmSync(file,{force:true});} catch {return null;}
  const age=now-Date.parse(String(marker?.at));
  if (!(age>=-5_000 && age<=MARKER_MS) || typeof marker.sessionId!=='string' || !SESSION_ID.test(marker.sessionId) || marker.runtime!==runtime) return null;
  return {sessionId:marker.sessionId,sessionSource:'marker'};
}
/** Who pushed, in the hook's order: CLAUDE_CODE_SESSION_ID, KHEREP_SESSION_ID, a fresh marker, else unknown. */
export function pushSession(runtime:Runtime, toplevel:string, env:NodeJS.ProcessEnv, now:number):PushSession {
  for (const name of ['CLAUDE_CODE_SESSION_ID','KHEREP_SESSION_ID']) {
    const id=env[name];
    if (id && SESSION_ID.test(id)) return {sessionId:id,sessionSource:name};
  }
  try {return takeMarker(path.join(configRoot(env),'control-plane'),runtime,toplevel,now) ?? {sessionId:'unknown',sessionSource:'none'};}
  catch {return {sessionId:'unknown',sessionSource:'none'};}
}
// Copy of trimAttribution in attribution.mts.
function trim(file:string, now:number):void {
  const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
  const kept=lines.filter(line=>{
    let at=Number.NaN;
    try {at=Date.parse((JSON.parse(line) as {ts?:unknown}|null)?.ts as string);} catch { /* unreadable */ }
    return now-(Number.isNaN(at)?-Infinity:at)<RETENTION_MS;
  });
  if (kept.length===lines.length) return;
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,kept.map(line=>`${line}\n`).join(''),{mode:0o600});
  fs.renameSync(temp,file);
}
export type BrokerPush = {session:PushSession; runtime:Runtime; repo:string; toplevel:string; branch:string; sha:string};
/** Appends one push record; never throws, false when nothing was written. */
export function recordBrokerPush(push:BrokerPush, env:NodeJS.ProcessEnv, now:number):boolean {
  try {
    const known=push.session.sessionId!=='unknown';
    const line=JSON.stringify({v:1,ts:new Date(now).toISOString(),kind:'push',sessionId:push.session.sessionId,runtime:known?push.runtime:'unknown',
      sessionSource:push.session.sessionSource,repo:push.repo,toplevel:push.toplevel,branch:push.branch,remoteRef:`refs/heads/${push.branch}`,sha:push.sha,pr:null});
    const dir=path.join(configRoot(env),'control-plane'), file=path.join(dir,'attribution.jsonl');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    fs.appendFileSync(file,`${line}\n`,{mode:0o600});
    try {trim(file,now);} catch { /* The record is written; trimming retries on the next append. */ }
    return true;
  } catch {return false;}
}
