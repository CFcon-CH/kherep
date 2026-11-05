// Issue #695: the evidence verb on a confirmed record. Injected session, git and file writes only;
// nothing here reaches a network, a real repository or a Confluence page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BODY, CONFIRMED, CONTRADICTS, decideArgs, harness, MEASUREMENT, NEWER, prepared, SHA, type HarnessOptions, type Pages } from './evidence-cli.fixture.mts';
import { runtimeLabel } from './confluence-runtime-label.mts';

const AT_NEWER = { ...CONTRADICTS, revision: `alpha@${NEWER}`, command: `git show ${NEWER}:src/queue.mts` };
const TARGET = `<p>Revision: alpha@${NEWER}</p><p>Code: src/queue.mts</p><p>The queue keeps receipts.</p>`;
const supArgs = { ...decideArgs, 'superseded-by': '77', 'body-approved': undefined };
const confirmed = (target: Pages[string] | null, options: HarnessOptions = {}, labels = CONFIRMED) =>
  harness({ '1': { body: BODY, labels }, ...(target ? { '77': target } : {}) }, options);
const record = (h: Awaited<ReturnType<typeof prepared>>) => JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}');
const mergeBases = (h: Awaited<ReturnType<typeof prepared>>) => h.execs.filter(c => c.includes('merge-base'));

test('T7 a contradiction at a newer commit supersedes a confirmed record through a target binding that commit', async () => {
  const h = await prepared(confirmed({ body: TARGET, labels: [] }, { mergeBase: SHA }), AT_NEWER);
  assert.equal(await h.run(supArgs), 0);
  assert.equal(h.calls.length, 2, 'metadata and body of the target, GET only');
  const body = h.files.get('/synthetic/evidence/b.xml') ?? '';
  assert.ok(body.includes('pages/77">Synthetic title</a>') && body.includes(`<p>Revision: alpha@${NEWER}</p>`), body);
  const r = record(h);
  assert.deepEqual([r.decision.outcome, r.decision.labelsRemove, r.decision.supersededBy], ['superseded', ['evidence-confirmed'], '77']);
  assert.ok(r.labelsAfter.includes('evidence-superseded') && !r.labelsAfter.includes('evidence-confirmed'));
  const printed = h.out.join('\n');
  for (const secret of ['/x/alpha', SHA, NEWER, 'Synthetic title', 'src/queue.mts', 'receipts']) assert.ok(!printed.includes(secret), secret);
  assert.deepEqual(mergeBases(h).map(c => c.slice(-2)), [[SHA, NEWER]]);
});

test('T7 not newer, unreadable, other-space and unbound targets are refused without a body', async () => {
  for (const mergeBase of ['d'.repeat(40), undefined]) {
    const h = await prepared(confirmed({ body: TARGET, labels: [] }, mergeBase === undefined ? {} : { mergeBase }), AT_NEWER);
    assert.equal(await h.run(supArgs), 2, String(mergeBase));
    assert.match(h.out.join('\n'), /reason: revision-not-newer/);
    assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
  }
  const archived = await prepared(confirmed({ body: TARGET, labels: [], status: 'archived' }, { mergeBase: SHA }), AT_NEWER);
  await assert.rejects(() => archived.run(supArgs), /superseded-page-not-current/);
  assert.equal(archived.files.has('/synthetic/evidence/b.xml'), false);
  const other = await prepared(confirmed({ body: TARGET, labels: [], spaceId: '8' }, { mergeBase: SHA }), AT_NEWER);
  assert.equal(await other.run(supArgs), 2);
  assert.match(other.out.join('\n'), /reason: superseded-other-space/);
  assert.equal(other.calls.length, 1, 'a target in another space is never read beyond its metadata');
  const unbound = await prepared(confirmed({ body: '<p>The queue keeps receipts.</p>', labels: [] }, { mergeBase: SHA }), AT_NEWER);
  assert.equal(await unbound.run(supArgs), 2);
  assert.match(unbound.out.join('\n'), /reason: superseded-page-not-bound/);
  // Without a target a later commit never refutes.
  const bare = await prepared(confirmed(null, { mergeBase: SHA }), AT_NEWER);
  assert.equal(await bare.run(decideArgs), 2);
  assert.match(bare.out.join('\n'), /reason: revision-not-on-page/);
});

test('T8 a holding re-measurement exits 0, writes no body and is neither verifiable nor a label change', async () => {
  const h = await prepared(confirmed(null), MEASUREMENT);
  assert.equal(await h.run(decideArgs), 0);
  assert.deepEqual(h.out.slice(-4), ['outcome: holds', 'reason: measured', 'labels: none', 'body: not written']);
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
  const r = record(h);
  assert.equal(r.decision.outcome, 'holds');
  assert.deepEqual(r.labelsAfter, r.labels);
  await assert.rejects(() => h.run({ mode: 'verify', record: '/synthetic/evidence/r.json', 'body-file': '/synthetic/evidence/b.xml' }), /no proposed change to verify/);
  h.out.length = 0;
  assert.equal(await h.run({ mode: 'report', records: '/synthetic/evidence/r.json' }), 0);
  const report = h.out.join('\n');
  assert.match(report, /- outcome: holds\n- reason: measured\n- label diff: none/);
  assert.match(report, /- holds: 1\n/);
  assert.ok(report.includes(`git show ${SHA}:src/queue.mts`) && report.includes('12: retry(receipt)'), report);
});

const subcommand = (c: string[]) => c[1] === '--version' ? '--version' : c[1] === '-C' ? c[3] : `?${c.join(' ')}`;
test('T9 git sees validated SHAs only, and merge-base runs only for an unbound revision of a confirmed record', async () => {
  const h = await prepared(confirmed({ body: TARGET, labels: [] }, { mergeBase: SHA }), AT_NEWER);
  assert.equal(await h.run(supArgs), 0);
  assert.ok(h.execs.every(c => c[0] === 'git' && ['--version', 'rev-parse', 'cat-file', 'merge-base'].includes(subcommand(c))), JSON.stringify(h.execs));
  assert.ok(h.execs.filter(c => ['cat-file', 'merge-base'].includes(subcommand(c))).every(c => c.slice(c[3] === 'cat-file' ? -1 : -2).every(a => /^[0-9a-f]{40}$/.test(a))));
  const runs: [string, Awaited<ReturnType<typeof prepared>>, Record<string, string | undefined>][] = [
    ['bound revision', await prepared(confirmed(null, { mergeBase: SHA }), CONTRADICTS), decideArgs],
    ['no --repo-root', await prepared(confirmed(null, { mergeBase: SHA }), AT_NEWER), { ...decideArgs, 'repo-root': undefined }],
    ['assumed record', await prepared(confirmed(null, { mergeBase: SHA }, CONFIRMED.map(l => l === 'evidence-confirmed' ? 'evidence-assumed' : l)), AT_NEWER), decideArgs],
    ['unsafe revision', await prepared(confirmed(null, { mergeBase: SHA }), { ...AT_NEWER, revision: `alpha@${NEWER}; touch x` }), decideArgs],
  ];
  for (const [name, run, args] of runs) {
    await run.run(args);
    assert.deepEqual(mergeBases(run), [], name);
  }
});

test('T10 the refuted record carries the label set verify will compare: the confirmed label swapped, runtime label kept or added', async () => {
  const h = await prepared(confirmed(null), CONTRADICTS);
  assert.equal(await h.run(decideArgs), 0);
  assert.match(h.files.get('/synthetic/evidence/b.xml') ?? '', /<p>Outcome: refuted \(model-run, status-author-model unchanged\)<\/p><p>Revision: alpha@a{40}<\/p>/);
  assert.deepEqual(h.out.slice(-4), ['outcome: refuted', 'reason: measured', 'labels: +evidence-refuted / -evidence-confirmed', 'body: written']);
  assert.deepEqual(record(h).labelsAfter, [...CONFIRMED.filter(l => l !== 'evidence-confirmed'), 'evidence-refuted'].sort());
  const bare = await prepared(confirmed(null, {}, CONFIRMED.filter(l => !l.startsWith('runtime-'))), CONTRADICTS);
  assert.equal(await bare.run(decideArgs), 0);
  assert.deepEqual(record(bare).labelsAfter,
    ['type-observation', 'evidence-refuted', 'status-author-model', runtimeLabel('KHEREP_ATL_CRED_FILE_CLAUDE', {})].sort());
});
