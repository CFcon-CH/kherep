// The evidence verb's path and record guards and two end-to-end decide runs (issue #519, second review).
// Injected session, git and files only; see evidence-cli.fixture.mts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceError } from './confluence-contract.mts';
import { decideArgs, harness, LABELS, MEASUREMENT, prepareArgs, prepared, TODAY } from './evidence-cli.fixture.mts';

test('P3-e: prepare and record refuse an existing --out before any request: out-exists', async () => {
  const h = await prepared();
  const before = h.files.get('/synthetic/evidence/r.json');
  await assert.rejects(() => h.run(prepareArgs), /out-exists/);
  await assert.rejects(() => h.run({ mode: 'record', id: '5', excluded: 'private', reason: 'private-no-local-route', out: '/synthetic/evidence/r.json' }), /out-exists/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.files.get('/synthetic/evidence/r.json'), before);
});

test('P3-e: a record whose labels is not a list raises a ConfluenceError, not a TypeError', async () => {
  const h = await prepared();
  const record = JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}');
  h.files.set('/synthetic/evidence/r.json', JSON.stringify({ ...record, labels: 'type-observation' }));
  await assert.rejects(() => h.run(decideArgs), (error: unknown) => error instanceof ConfluenceError && /record malformed/.test(error.message));
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
});

test('P3-e: the git check runs on the resolved directory, which must exist', async () => {
  const h = harness(undefined, { links: { '/tmp/link': '/repo/linked', '/tmp/gone': null } });
  await assert.rejects(() => h.run({ ...prepareArgs, out: '/tmp/link/r.json' }), /out-inside-repository/);
  assert.ok(h.execs.some(c => c.includes('/repo/linked')), 'git sees the real directory');
  assert.ok(!h.execs.some(c => c.includes('/tmp/link')), 'git never sees the link');
  await assert.rejects(() => h.run({ ...prepareArgs, out: '/tmp/gone/r.json' }), /cannot be shown to lie outside a repository: its directory does not resolve/);
  assert.deepEqual([h.calls.length, h.files.size], [0, 0]);
});

test('P3: every write goes to the resolved real directory, never through the link', async () => {
  const h = harness(undefined, { links: { '/tmp/link': '/tmp/real' } });
  assert.equal(await h.run({ ...prepareArgs, out: '/tmp/link/r.json' }), 0);
  assert.deepEqual([...h.files.keys()], ['/tmp/real/r.json']);
  // The record exists only in the real directory, so decide must read it there too.
  h.files.set('/tmp/link/m.json', JSON.stringify(MEASUREMENT));
  assert.equal(await h.run({ ...decideArgs, record: '/tmp/link/r.json', measurement: '/tmp/link/m.json', 'out-body': '/tmp/link/b.xml' }), 0);
  assert.ok(h.files.has('/tmp/real/b.xml') && !h.files.has('/tmp/link/b.xml'), [...h.files.keys()].join(', '));
  assert.ok(JSON.parse(h.files.get('/tmp/real/r.json') ?? '{}').decision, 'the record is written back to the real directory');
});

test('P3-f: git that does not run refuses every path: git does not run', async () => {
  const missing = async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };
  const h = harness(undefined, { exec: missing });
  await assert.rejects(() => h.run(prepareArgs), /cannot be shown to lie outside a repository: git does not run/);
  assert.deepEqual([h.calls.length, h.files.size], [0, 0]);
});

async function endToEnd(body: string, kind: string, measurement: object, args: Record<string, string | undefined> = decideArgs) {
  const h = await prepared(harness({ '1': { body, labels: LABELS } }), measurement);
  assert.ok(h.out.includes(`kind: ${kind}`), h.out.join('\n'));
  assert.equal(await h.run(args), 0, h.out.join('\n'));
  assert.equal(h.calls.length, 0, 'decide sends no request');
  const written = h.files.get('/synthetic/evidence/b.xml') ?? '';
  const record = JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}');
  assert.deepEqual([record.decision.outcome, record.decision.labelsAdd, record.decision.labelsRemove],
    ['confirmed', ['evidence-confirmed'], ['evidence-assumed']]);
  // The operator's update and labels calls, then verify against the same fixture state.
  const v = harness({ '1': { body: written, labels: record.labelsAfter } });
  for (const [k, value] of h.files) v.files.set(k, value);
  assert.equal(await v.run({ mode: 'verify', record: '/synthetic/evidence/r.json', 'body-file': '/synthetic/evidence/b.xml' }), 0);
  assert.equal(v.out.at(-1), 'readback: match');
  return { written, record };
}

test('P3-f: decide end to end for a tracker claim', async () => {
  const { written } = await endToEnd('<p>Tracker: KEY-12 holds the queue retry fix.</p><h2>Related pages</h2>', 'tracker',
    { kind: 'tracker', source: 'KEY-12', sourceClass: 'tracker', command: 'jira get --key KEY-12', excerpt: 'key: KEY-12\nstate: Done',
      measuredAt: TODAY, verdict: 'reproduces' });
  assert.ok(written.startsWith('<p>Tracker: KEY-12 holds the queue retry fix.</p><h2>Measurement 2026-10-22</h2>'), written);
  assert.ok(written.endsWith('<h2>Related pages</h2>'));
});

test('P3-f: decide end to end for a doc claim, LF-only and with " as &quot;', async () => {
  const url = 'https://developer.atlassian.com/cloud/confluence/rest/v2/intro/';
  const { written, record } = await endToEnd(`<p>Doc: ${url}</p><p>Page lists paginate with a cursor.</p><h2>Related pages</h2>`, 'doc',
    { kind: 'doc', source: url, sourceClass: 'official-doc', command: `curl -sL ${url}`, subject: 'cursor',
      excerpt: 'The "cursor" isn\'t an offset.\r\nNext: a cursor link', measuredAt: TODAY, verdict: 'reproduces' });
  assert.ok(written.includes('<pre>The &quot;cursor&quot; isn\'t an offset.\nNext: a cursor link</pre>'), written);
  assert.ok(!/\r|&#39;/.test(written), written);
  assert.equal(record.measurement.excerpt, 'The "cursor" isn\'t an offset.\nNext: a cursor link');
});

// Issue #650: the measurement block is metadata, so a .mts tool in the command never makes a tracker page code-bound.
const TRACKER_PAGE = '<p>Tracker: KEY-12 holds the queue retry fix.</p><h2>Related pages</h2>';
const CCODER = { kind: 'tracker', source: 'KEY-12', sourceClass: 'tracker', command: 'node tools/atl-jira-ccoder.mts get --key KEY-12',
  excerpt: 'key: KEY-12\nstate: Done', measuredAt: TODAY, verdict: 'reproduces' };
const withoutRepo = Object.fromEntries(Object.entries(decideArgs).filter(([key]) => key !== 'repo-root'));

test('#650 T3: decide end to end confirms a tracker claim measured with atl-jira-ccoder.mts', async () => {
  const { written, record } = await endToEnd(TRACKER_PAGE, 'tracker', CCODER, withoutRepo);
  assert.ok(written.startsWith('<p>Tracker: KEY-12 holds the queue retry fix.</p><h2>Measurement 2026-10-22</h2>'), written);
  assert.ok(record.labelsAfter.includes('evidence-confirmed'), record.labelsAfter.join(', '));
});

test('#650 T4: an original Measurement heading with code still refuses: promoted-body-revision-invalid', async () => {
  const body = `<h2>Measurement ${TODAY}</h2><p>Code: src/queue.mts</p>${TRACKER_PAGE}`;
  const h = await prepared(harness({ '1': { body, labels: LABELS } }), { ...CCODER, kindOverride: 'the claim is the tracker state' },
    { ...prepareArgs, kind: 'tracker' });
  assert.ok(h.out.includes('kind: tracker (override; classified code)'), h.out.join('\n'));
  assert.equal(await h.run(withoutRepo), 2);
  assert.match(h.out.join('\n'), /reason: promoted-body-revision-invalid/);
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
});
