import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { strictCodexNode } from './target-resume-fixture.mts';
import { deliver, missListings, SESSION } from './closed-fixture.mts';
import { deliverToClosed } from './closed-delivery.mts';
import { getMessage } from './inbox.mts';
import { advanceTargetResume, TARGET_RESUME_WAIT_MS } from './target-resume.mts';
import { withRoute } from './target-delivery-route.mts';
import { T0 } from './task-fixture.mts';
import { killSwitch } from './wake-hook.mts';

test('confirmed Queue waits the complete fixed ten minutes and never shortens the wait at expiry', async t => {
  const node = strictCodexNode(t), id = deliver(node);
  await deliverToClosed(node.deps());
  const handle = getMessage(node.paths.inbox, id)!.targetAttempt!;
  const original = withRoute(node.paths, handle, s => s);
  assert.equal(original.targetResume?.dueAt, T0 + TARGET_RESUME_WAIT_MS);
  node.tick(599_999);
  assert.equal((await advanceTargetResume(node.deps(), SESSION)).status, 'queued-awaiting-original');
  node.tick(1);
  assert.deepEqual(await advanceTargetResume(node.deps(), SESSION), { status: 'unavailable', reason: 'original-successor-unavailable' });
  node.tick(24 * 60 * 60_000);
  assert.deepEqual(await advanceTargetResume(node.deps(), SESSION), { status: 'refused', reason: 'deadline' });
  assert.equal(node.queues.length, 1);
  assert.deepEqual(withRoute(node.paths, handle, s => s.budget), original.budget);
});

test('clock rollback fences the confirmed Queue without releasing ownership or another effect', async t => {
  const node = strictCodexNode(t), id = deliver(node);
  await deliverToClosed(node.deps());
  node.tick(-1);
  assert.deepEqual(await advanceTargetResume(node.deps(), SESSION), { status: 'unknown-fenced', reason: 'queue-state-unknown' });
  assert.equal(node.queues.length, 1);
  assert.ok(withRoute(node.paths, getMessage(node.paths.inbox, id)!.targetAttempt!, s => s.budget));
});

test('final actual Queue callback rejects SEND expiry after an await with fresh current Authority', async t => {
  const node = strictCodexNode(t), id = deliver(node);
  const base = node.deps(), prepare = node.port.prepare.bind(node.port);
  const port = { async prepare() {
    const p = await prepare();
    return { ...p, async queue(...args: Parameters<typeof p.queue>) {
      await Promise.resolve();
      node.tick(24 * 60 * 60_000 - 5_000);
      missListings(node, 3, node.deps().now!());
      return p.queue(...args);
    } };
  } };
  await deliverToClosed({ ...base, targetResumePort: port });
  assert.equal(node.queues.length, 0);
  const state = withRoute(node.paths, getMessage(node.paths.inbox, id)!.targetAttempt!, s => s);
  assert.equal(state.phase, 'uncertain');
  assert.ok(state.budget);
});

test('the actual Queue callback rejects a new kill switch after its preparation await', async t => {
  const node = strictCodexNode(t), id = deliver(node), prepare = node.port.prepare.bind(node.port);
  const port = { async prepare() {
    const p = await prepare();
    return { ...p, async queue(...args: Parameters<typeof p.queue>) {
      await Promise.resolve(); fs.writeFileSync(killSwitch(node.paths), '');
      return p.queue(...args);
    } };
  } };
  await deliverToClosed({ ...node.deps(), targetResumePort: port });
  assert.equal(node.queues.length, 0);
  assert.ok(withRoute(node.paths, getMessage(node.paths.inbox, id)!.targetAttempt!, s => s.budget));
});

test('prepared original binding keeps the complete original identity and background intent without the body', async t => {
  const node = strictCodexNode(t), id = deliver(node), prepare = node.port.prepare.bind(node.port);
  let observed: unknown;
  const port = { async prepare(target: Readonly<import('./target-resume-port.mts').OriginalTarget>) {
    observed = target;
    const p = await prepare();
    assert.equal(JSON.stringify(p.queueLaunch.rawArgs).includes('are the tests green?'), false);
    assert.equal(JSON.stringify(p.resumeLaunch.rawArgs).includes('are the tests green?'), false);
    return p;
  } };
  await deliverToClosed({ ...node.deps(), targetResumePort: port });
  assert.deepEqual(observed, { sessionId: SESSION, runtime: 'codex', permissionMode: 'auto',
    cwd: fs.realpathSync.native(path.join(node.workspace, 'repo')), lifecycleGeneration: 7, background: true });
  assert.ok(getMessage(node.paths.inbox, id)?.targetAttempt);
});

import {withOriginalPointerExclusion,consumeOriginalPointerToken,assertOriginalPointerLease} from './target-resume-fence.mts';
import type {OriginalPointerExpectation,PreparedOriginalPort} from './target-resume-port.mts';
test('native token rejects copied reused expired and fake delete authority',async()=>{
 const expected={} as OriginalPointerExpectation;let token:any;const adapter={async withRetiredPointerFence(want:any,consume:any){return await consume({epoch:'aaaa0000-0000-4000-8000-000000000002',assertActive(){}});}} as PreparedOriginalPort;
 await withOriginalPointerExclusion(adapter,expected,async value=>{token=value;assert.throws(()=>consumeOriginalPointerToken({...value},expected));assert.throws(()=>assertOriginalPointerLease(value,{...adapter},expected));consumeOriginalPointerToken(value,expected);assert.throws(()=>consumeOriginalPointerToken(value,expected));return true;});assert.throws(()=>consumeOriginalPointerToken(token,expected));
 const fake={async withRetiredPointerFence(){return {deleted:true};}} as unknown as PreparedOriginalPort;let effects=0;await assert.rejects(withOriginalPointerExclusion(fake,expected,async()=>{effects++;return true;}));assert.equal(effects,0);
});

test('early provider return invalidates the live token before a delayed input seam',async()=>{
 const expected={} as OriginalPointerExpectation;let release!:()=>void,effects=0;const gate=new Promise<void>(resolve=>{release=resolve;});let continuation:Promise<void>|undefined;
 const adapter={async withRetiredPointerFence(want:any,consume:any){void consume({epoch:'aaaa0000-0000-4000-8000-000000000002',assertActive(){}});return {status:'unknown'};}} as PreparedOriginalPort;
 await assert.rejects(withOriginalPointerExclusion(adapter,expected,async token=>{continuation=(async()=>{await gate;assertOriginalPointerLease(token,adapter,expected);effects++;})();return await continuation;}));release();await assert.rejects(continuation!);assert.equal(effects,0);
});
