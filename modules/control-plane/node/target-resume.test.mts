import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { closedNode, deliver, endedIntercom, SESSION } from './closed-fixture.mts';
import { deliverToClosed } from './closed-delivery.mts';
import { getMessage, getMessageProgress } from './inbox.mts';
import { DEFAULT_POLICY, loadPolicy } from './policy.mts';
import { checkPolicy } from './doctor-local.mts';
import { rememberMode } from './autonomy.mts';

// These are source doubles. No native provider, original chat or platform acceptance.
test('strict original selection precedes a reusable intercom and unavailable provider spends nothing', async t => {
  const node = closedNode(t, {}, { resumeTarget: true });
  const { id } = await endedIntercom(node);
  const before = node.calls.length;
  rememberMode(node.paths, SESSION, 'auto');
  await deliverToClosed(node.deps());
  assert.equal(node.calls.length, before);
  const row = getMessage(node.paths.inbox, id)!;
  assert.equal(row.state, 'accepted');
  assert.equal(row.toSession, SESSION);
  assert.equal(row.closedAttempt, undefined);
  assert.equal(row.targetAttempt, undefined);
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, 'awaiting-user-turn');
  assert.equal(fs.existsSync(path.join(node.paths.dir, 'codex-native-pending', `${SESSION}.json`)), false);
  assert.equal(fs.existsSync(path.join(node.paths.dir, 'listeners', `${SESSION}.turns.json`)), false);
});

test('resumeTarget is default off and retains the explicit legacy mode', async t => {
  assert.equal(DEFAULT_POLICY.messaging?.resumeTarget, undefined);
  const node = closedNode(t);
  const id = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(node.calls.filter(c => c.args[0] !== 'agents').length, 1);
  assert.notEqual(getMessage(node.paths.inbox, id)?.toSession, SESSION);
});

test('invalid resumeTarget disables the complete messaging section without legacy fallback', async t => {
  for (const value of ['true', 1, {}, null, []]) {
    const node = closedNode(t, {}, { resumeTarget: value });
    const id = deliver(node);
    assert.equal(loadPolicy(node.paths.policy).messaging, undefined);
    await deliverToClosed(node.deps());
    assert.equal(node.calls.length, 0);
    assert.equal(getMessage(node.paths.inbox, id)?.state, 'accepted');
  }
});

test('resumeTarget true is parsed and false remains off', t => {
  const node = closedNode(t, {}, { resumeTarget: true });
  assert.equal(node.deps().policy.messaging?.resumeTarget, true);
  const raw = JSON.parse(fs.readFileSync(node.paths.policy, 'utf8'));
  raw.messaging.resumeTarget = false;
  fs.writeFileSync(node.paths.policy, JSON.stringify(raw));
  assert.equal(node.deps().policy.messaging?.resumeTarget, undefined);
  assert.equal(node.deps().policy.messaging?.resumeClosed, true);
});

test('strict original without resumeClosed is inert and doctor reports its missing prerequisite', async t => {
  const node = closedNode(t, {}, { resumeTarget: true, resumeClosed: false });
  const id = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(node.calls.length, 0);
  assert.equal(getMessage(node.paths.inbox, id)?.state, 'accepted');
  const report = checkPolicy(node.paths.policy).check;
  assert.deepEqual(report.targetResume, { selected: true, resumeClosed: false, nativeQueue: false, provider: 'unavailable', waitMs: 600_000 });
});

test('strict original uses the recorded permission mode and refuses unknown mode before preparation', async t => {
  const node = closedNode(t, {}, { resumeTarget: true });
  const id = deliver(node);
  let prepares = 0;
  const deps = { ...node.deps(), targetResumePort: { async prepare() { prepares++; return { status: 'unavailable' as const }; } } };
  await deliverToClosed(deps);
  assert.equal(prepares, 0);
  assert.equal(node.calls.length, 0);
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, 'permission-restricted');
});

test('strict Codex submits one bounded pointer to the same original owner and retains one debit across rounds', async t => {
  const { strictCodexNode } = await import('./target-resume-fixture.mts');
  const node = strictCodexNode(t);
  const first = deliver(node), second = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(node.queues.length, 1);
  assert.equal(JSON.stringify(node.queues[0].input).includes('are the tests green?'), false);
  const row = getMessage(node.paths.inbox, first)!;
  assert.equal(row.toSession, SESSION);
  assert.deepEqual(row.targetAttempt, getMessage(node.paths.inbox, second)?.targetAttempt);
  assert.ok(row.targetAttempt);
  const { withRoute } = await import('./target-delivery-route.mts');
  const initial = withRoute(node.paths, row.targetAttempt, s => s);
  assert.equal(initial.owner, SESSION);
  assert.equal(initial.group.operation.execution.sessionId, SESSION);
  assert.equal(initial.group.operation.budgetOwner, SESSION);
  assert.equal(initial.group.binding.members.length, 2);
  assert.equal(initial.outcome?.kind, 'queue');
  await deliverToClosed(node.deps());
  const later = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(node.queues.length, 1);
  assert.deepEqual(withRoute(node.paths, row.targetAttempt, s => s.budget), initial.budget);
  assert.equal(getMessage(node.paths.inbox, later)?.targetAttempt, undefined);
});

test('concurrent actual closed rounds share the original owner and admit only one Queue effect', async t => {
  const { strictCodexNode } = await import('./target-resume-fixture.mts');
  const node = strictCodexNode(t), first = deliver(node), second = deliver(node);
  await Promise.all([deliverToClosed(node.deps()), deliverToClosed(node.deps())]);
  assert.equal(node.queues.length, 1);
  assert.deepEqual(getMessage(node.paths.inbox, first)?.targetAttempt, getMessage(node.paths.inbox, second)?.targetAttempt);
  const { withRoute } = await import('./target-delivery-route.mts');
  const state = withRoute(node.paths, getMessage(node.paths.inbox, first)!.targetAttempt!, s => s);
  assert.equal(state.outcomes.length, 1);
  assert.equal(state.group.binding.members.length, 2);
});
