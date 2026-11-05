// The evidence verb's I/O boundary: injected session, git and file writes only.
// Nothing here reaches a network, a real repository or a Confluence page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './atl-confluence-ccoder.mts';
import { BODY, decideArgs, harness, LABELS, MEASUREMENT, prepareArgs as prepare, prepared, SHA, TODAY } from './evidence-cli.fixture.mts';
import { runtimeLabel } from './confluence-runtime-label.mts';
import { renderMeasurementBlock } from './confluence-evidence.mts';

test('Defect 5: prepare refuses without body approval or with an --out inside a work tree, before any request', async () => {
  const h = harness();
  await assert.rejects(() => h.run({ mode: 'prepare', id: '1', space: 'K', out: '/synthetic/evidence/r.json' }), /body-approved/);
  await assert.rejects(() => h.run({ ...prepare, out: '/repo/notes/r.json' }), /out-inside-repository/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.files.size, 0);
});

test('Defect 5: only git\'s explicit "not a git repository" counts as outside; any other git error refuses', async () => {
  const h = harness();
  await assert.rejects(() => h.run({ ...prepare, out: '/dubious/r.json' }), /cannot be shown to lie outside/);
  const decided = await prepared();
  await assert.rejects(() => decided.run({ ...decideArgs, 'out-body': '/dubious/b.xml' }), /cannot be shown to lie outside/);
  assert.deepEqual([h.calls.length, h.files.size, decided.calls.length, decided.files.has('/dubious/b.xml')], [0, 0, 0, false]);
  assert.equal(await h.run(prepare), 0, 'fatal: not a git repository is the explicit negative');
});

test('prepare reads with GET only, prints metadata only and writes body and title to the record', async () => {
  const h = harness();
  assert.equal(await h.run(prepare), 0);
  assert.ok(h.calls.length > 0);
  const printed = h.out.join('\n');
  assert.ok(!printed.includes('Synthetic title') && !printed.includes('receipt identity') && !printed.includes('src/queue.mts'));
  assert.match(printed, /kind: code/);
  const record = JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}');
  assert.equal(record.title, 'Synthetic title');
  assert.equal(record.body, BODY);
  assert.equal(record.claim.bodyApproved, true);
});

test('#666: prepare prints the number of appended blocks it treats as metadata', async () => {
  const trk = '<p>Tracker: KEY-12 holds the queue retry fix.</p>';
  const block = renderMeasurementBlock({ outcome: 'confirmed', reason: 'measured', labelsAdd: [], labelsRemove: [] }, { kind: 'tracker',
    source: 'KEY-12', sourceClass: 'tracker', command: 'node tools/atl-jira-ccoder.mts get --key KEY-12', excerpt: 'state: Done',
    measuredAt: TODAY, verdict: 'reproduces' }, 'runtime-claude-code-win');
  const footer = '<h2>Related pages</h2>';
  for (const [body, line, kind] of [[BODY, 'measurement blocks: 0', 'code'], [trk + block + footer, 'measurement blocks: 1', 'tracker'],
    [trk + block + '<p>x</p>' + footer, 'measurement blocks: 0', 'code']]) {
    const h = harness({ '1': { body, labels: LABELS } });
    assert.equal(await h.run(prepare), 0);
    const printed = h.out.join('\n');
    assert.ok(h.out.includes(line) && h.out.includes(`kind: ${kind}`), printed);
    assert.ok(!printed.includes('Synthetic title') && !printed.includes('KEY-12') && !printed.includes('.mts'), printed);
  }
});

test('decide performs zero requests, writes the body and appends the decision; exit codes 0 and 2', async () => {
  const h = await prepared();
  assert.equal(await h.run(decideArgs), 0);
  assert.equal(h.calls.length, 0);
  assert.ok(h.files.get('/synthetic/evidence/b.xml')?.includes('<h2>Measurement 2026-10-22</h2>'));
  const record = JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}');
  assert.equal(record.decision.outcome, 'confirmed');
  assert.deepEqual(record.labelsAfter, ['evidence-confirmed', 'runtime-claude-code-win', 'status-author-model', 'type-observation']);
  const stale = await prepared(harness(), { ...MEASUREMENT, measuredAt: '2026-10-10' });
  assert.equal(await stale.run(decideArgs), 2);
  assert.equal(stale.files.has('/synthetic/evidence/b.xml'), false);
  assert.match(stale.out.join('\n'), /reason: measurement-stale/);
});

test('Defect 4 and 5: a secret marker writes no body; --out-body inside a work tree exits before reading', async () => {
  const h = await prepared(harness(), { ...MEASUREMENT, excerpt: 'Bearer ' + 'abc' });
  assert.equal(await h.run(decideArgs), 2);
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
  assert.ok(!h.out.join('\n').includes('abc'));
  const inside = await prepared();
  await assert.rejects(() => inside.run({ ...decideArgs, 'out-body': '/repo/b.xml' }), /out-inside-repository/);
  assert.equal(inside.files.has('/repo/b.xml'), false);
});

test('--superseded-by needs body approval, then two GETs, and refuses another space after one', async () => {
  const contradicts = { ...MEASUREMENT, verdict: 'contradicts' };
  const h = await prepared(harness({ '1': { body: BODY, labels: LABELS }, '77': { body: '<p>x</p>', labels: [] } }), contradicts);
  await assert.rejects(() => h.run({ ...decideArgs, 'superseded-by': '77' }), /body-approved/);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.run({ ...decideArgs, 'superseded-by': '77', 'body-approved': undefined }), 0);
  assert.equal(h.calls.length, 2, 'metadata, then the storage body of a same-space target');
  assert.match(h.files.get('/synthetic/evidence/b.xml') ?? '', /pages\/77">Synthetic title<\/a>/);
  const other = await prepared(harness({ '1': { body: BODY, labels: LABELS }, '78': { body: '', labels: [], spaceId: '8' } }), contradicts);
  assert.equal(await other.run({ ...decideArgs, 'superseded-by': '78', 'body-approved': undefined }), 2);
  assert.match(other.out.join('\n'), /superseded-other-space/);
  assert.equal(other.calls.length, 1, 'the body of a page in another space is not read');
});

const UNBOUND = '<p>Revision: none (no exact binding: dirty tree)</p><p>Code: src/queue.mts</p><h2>Related pages</h2>';
const SUPERSEDING = `<p>Revision: alpha@${SHA}</p><p>Code: src/queue.mts</p><p>The queue keeps receipts.</p>`;
const supArgs = { ...decideArgs, 'superseded-by': '77', 'body-approved': undefined };

test('#687 --superseded-by on an unbound code record: two GETs, superseded, no body text printed', async () => {
  const h = await prepared(harness({ '1': { body: UNBOUND, labels: LABELS }, '77': { body: SUPERSEDING, labels: [] } }), { ...MEASUREMENT, verdict: 'contradicts' });
  assert.equal(await h.run(supArgs), 0);
  assert.equal(h.calls.length, 2);
  const body = h.files.get('/synthetic/evidence/b.xml') ?? '';
  assert.ok(body.includes('pages/77">Synthetic title</a>') && body.includes(`<p>Revision: alpha@${SHA}</p>`), body);
  const record = JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}');
  assert.equal(record.decision.outcome, 'superseded');
  assert.ok(record.labelsAfter.includes('evidence-superseded') && !record.labelsAfter.includes('evidence-assumed'));
  const printed = h.out.join('\n');
  assert.ok(!printed.includes('src/queue.mts') && !printed.includes('Synthetic title') && !printed.includes('receipts'), printed);
});

test('#687 a superseding page that does not bind the revision, or is not current, is refused', async () => {
  const h = await prepared(harness({ '1': { body: UNBOUND, labels: LABELS }, '77': { body: '<p>x</p>', labels: [] } }), { ...MEASUREMENT, verdict: 'contradicts' });
  assert.equal(await h.run(supArgs), 2);
  assert.match(h.out.join('\n'), /reason: superseded-page-not-bound/);
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
  const archived = await prepared(harness({ '1': { body: UNBOUND, labels: LABELS }, '77': { body: SUPERSEDING, labels: [], status: 'archived' } }),
    { ...MEASUREMENT, verdict: 'contradicts' });
  await assert.rejects(() => archived.run(supArgs), /superseded-page-not-current/);
  assert.deepEqual([archived.calls.length, archived.files.has('/synthetic/evidence/b.xml')], [1, false]);
});

test('#687 an unbound record without a target stays revision-not-on-page and reads nothing', async () => {
  for (const verdict of ['reproduces', 'contradicts']) {
    const h = await prepared(harness({ '1': { body: UNBOUND, labels: LABELS } }), { ...MEASUREMENT, verdict });
    assert.equal(await h.run(decideArgs), 2, verdict);
    assert.match(h.out.join('\n'), /reason: revision-not-on-page/);
    assert.equal(h.calls.length, 0);
  }
});

test('--max-age-days above 7 exits 1 through the broker', async () => {
  const errors: string[] = [];
  const code = await runCli(['evidence', '--mode', 'decide', '--record', 'r.json', '--measurement', 'm.json', '--out-body', 'b.xml',
    '--max-age-days', '8'], { log: () => {}, logError: line => errors.push(line), readFile: async () => { throw new Error('unread'); } });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /max-age-days-above-cap/);
});

test('git receives only a validated 40-hex SHA', async () => {
  const bad = await prepared(harness(), { ...MEASUREMENT, revision: `alpha@${SHA}; touch x` });
  assert.equal(await bad.run(decideArgs), 2);
  assert.ok(!bad.execs.some(c => c.includes('cat-file')));
  const good = await prepared();
  assert.equal(await good.run(decideArgs), 0);
  const catFile = good.execs.filter(c => c.includes('cat-file'));
  assert.equal(catFile.length, 1);
  assert.ok(catFile.every(c => /^[0-9a-f]{40}$/.test(c.at(-1) ?? '')));
  assert.ok(good.execs.filter(c => c.includes('merge-base')).every(c => c.slice(-2).every(a => /^[0-9a-f]{40}$/.test(a)))); // #695
});

test('Defect 2: verify matches only the reviewed body with exactly the outcome label', async () => {
  const h = await prepared();
  assert.equal(await h.run(decideArgs), 0);
  const body = h.files.get('/synthetic/evidence/b.xml') ?? '';
  const verify = { mode: 'verify', record: '/synthetic/evidence/r.json', 'body-file': '/synthetic/evidence/b.xml' };
  const run = async (pageBody: string, labels: string[]) => {
    const v = harness({ '1': { body: pageBody, labels } });
    for (const [k, value] of h.files) v.files.set(k, value);
    return [await v.run(verify), v.out.at(-1)];
  };
  const after: string[] = JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}').labelsAfter;
  assert.deepEqual(after, ['evidence-confirmed', 'runtime-claude-code-win', 'status-author-model', 'type-observation']);
  assert.deepEqual(await run(body, [...after].reverse()), [0, 'readback: match']);
  assert.deepEqual(await run(body, [...after, 'evidence-assumed']), [2, 'readback: mismatch labels (+evidence-assumed)']);
  assert.deepEqual(await run(body, ['type-observation']),
    [2, 'readback: mismatch labels (-evidence-confirmed, -runtime-claude-code-win, -status-author-model)']);
  assert.deepEqual(await run(body.replace('retry', 'retrz'), after), [2, 'readback: mismatch body']);
  // Any label change between prepare and apply is a mismatch, not only the evidence label.
  const verified = after.map(l => l === 'status-author-model' ? 'status-author-verified' : l);
  assert.deepEqual(await run(body, verified), [2, 'readback: mismatch labels (+status-author-verified, -status-author-model)']);
  assert.deepEqual(await run(body, [...after, 'currency-uncertain']), [2, 'readback: mismatch labels (+currency-uncertain)']);
});

test('#662: verify matches a readback that carries &quot; and refuses the raw-quote form Confluence never returns', async () => {
  const h = await prepared(harness(), { ...MEASUREMENT, excerpt: '12: retry("receipt")\n13: say "done"' });
  assert.equal(await h.run(decideArgs), 0);
  const body = h.files.get('/synthetic/evidence/b.xml') ?? '';
  assert.ok(body.includes('<pre>12: retry(&quot;receipt&quot;)\n13: say &quot;done&quot;</pre>'), body);
  const after: string[] = JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}').labelsAfter;
  const run = async (pageBody: string) => {
    const v = harness({ '1': { body: pageBody, labels: after } });
    for (const [k, value] of h.files) v.files.set(k, value);
    return [await v.run({ mode: 'verify', record: '/synthetic/evidence/r.json', 'body-file': '/synthetic/evidence/b.xml' }), v.out.at(-1)];
  };
  assert.deepEqual(await run(body), [0, 'readback: match']);
  assert.deepEqual(await run(body.replaceAll('&quot;', '"')), [2, 'readback: mismatch body']);
});

test('labelsAfter anticipates the runtime label the labels call adds to a page without one', async () => {
  const h = await prepared(harness({ '1': { body: BODY, labels: LABELS.slice(0, 3) } }));
  assert.equal(await h.run(decideArgs), 0);
  const record = JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}');
  assert.ok(record.labelsAfter.includes(runtimeLabel('KHEREP_ATL_CRED_FILE_CLAUDE', {})));
  assert.equal(record.labelsAfter.filter((l: string) => l.startsWith('runtime-')).length, 1);
});

test('--superseded-by naming the page itself refuses before any read: superseded-same-page', async () => {
  const h = await prepared(harness(), { ...MEASUREMENT, verdict: 'contradicts' });
  await assert.rejects(() => h.run({ ...decideArgs, 'superseded-by': '1', 'body-approved': undefined }), /superseded-same-page/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
});

test('a promoted body the drainage scan would flag stays unknown: promoted-body-revision-invalid', async () => {
  const page = '<p>Host: alpha-node</p><p>The port in src/queue.mts is 8443.</p><h2>Related pages</h2>';
  const h = harness({ '1': { body: page, labels: LABELS } });
  assert.equal(await h.run({ ...prepare, kind: 'live' }), 0);
  assert.ok(h.out.includes('kind: live (override; classified code)'), h.out.join('\n'));
  h.files.set('/synthetic/evidence/m.json', JSON.stringify({ kind: 'live', source: 'alpha-node', sourceClass: 'target-host',
    command: 'ss -ltn | grep -E "8443|8080"', excerpt: 'LISTEN 0 4096 *:8080', measuredAt: TODAY, verdict: 'contradicts',
    subject: '8443', kindOverride: 'the claim is about the running host' }));
  assert.equal(await h.run(decideArgs), 2);
  assert.match(h.out.join('\n'), /reason: promoted-body-revision-invalid/);
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
  const record = JSON.parse(h.files.get('/synthetic/evidence/r.json') ?? '{}');
  assert.deepEqual([record.decision.outcome, record.decision.labelsAdd, record.labelsAfter], ['unknown', [], [...LABELS].sort()]);
});

test('record registers an excluded page without a GET and report renders it', async () => {
  const h = harness();
  assert.equal(await h.run({ mode: 'record', id: '5', excluded: 'private', reason: 'private-no-local-route', out: '/synthetic/evidence/x.json' }), 0);
  await assert.rejects(() => h.run({ mode: 'record', id: '5', excluded: 'private', reason: 'free text with spaces', out: '/synthetic/evidence/y.json' }));
  assert.equal(h.calls.length, 0);
  assert.equal(await h.run({ mode: 'report', records: '/synthetic/evidence/x.json' }), 0);
  assert.match(h.out.join('\n'), /excluded: private[\s\S]*private-no-local-route/);
  await assert.rejects(() => h.run({ mode: 'unknown' }), /--mode/);
});
