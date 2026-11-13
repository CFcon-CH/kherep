import assert from 'node:assert/strict';
import test from 'node:test';
import { scanDrainage } from './confluence-drainage-scan.mts';
import { drainageRules } from './confluence-drainage-rules.mts';
import { renderMeasurementBlock } from './confluence-evidence.mts';
import { updatePage } from './confluence-content.mts';
import { spaceIndex } from './confluence-related.mts';
import type { ConfluenceSession, RequestSpec } from './confluence-contract.mts';

const body = '<p>Measured queue delivery retries preserve receipt identity across reconnects and reject stale acknowledgements before delivery.</p>';
function page(id = '1', value = body, labels: string[] = []) {
  return { id, title: `Synthetic ${id}`, spaceId: '9', status: 'current', parentId: null,
    version: { number: 3 }, body: { storage: { value } }, labels };
}
function harness(pages = [page()], failure?: (spec: RequestSpec, count: number) => unknown) {
  const calls: RequestSpec[] = [];
  const session: ConfluenceSession = { async request(spec) {
    assert.equal(spec.method, 'GET', 'scanner must never mutate'); calls.push(spec);
    const overridden = failure?.(spec, calls.length);
    if (overridden !== undefined) return { status: 200, json: overridden };
    if (spec.path.includes('/spaces/')) return { status: 200, json: { results: pages } };
    const p = pages.find(p => p.id === /\/pages\/(\d+)(?:[/?]|$)/.exec(spec.path)?.[1]);
    if (spec.path.includes('/labels')) return { status: 200, json: { results: p?.labels.map(name => ({ name })) } };
    return { status: 200, json: p };
  } };
  return { calls, session };
}
const opts = { spaceId: '9', metadataApproved: true, now: () => 1000 };

test('complete scan is deterministic, GET only and contains no raw body', async () => {
  const {session} = harness();
  const one = await scanDrainage(session, opts);
  assert.equal(one.inventory.status, 'complete');
  assert.deepEqual(one, await scanDrainage(session, opts));
  assert.ok(!JSON.stringify(one).includes('acknowledgements'));
  assert.equal(one.semanticReview, 'UNKNOWN');
});
test('subset and exclusions never make a global orphan verdict', async () => {
  const {session, calls} = harness([page(), page('2')]);
  const r = await scanDrainage(session, {...opts, pageIds: ['1'], excludeIds: ['2']});
  assert.equal(r.graph, 'not-evaluated');
  assert.ok(!r.candidates.some(c => c.problem === 'no-incoming-link'));
  assert.ok(!calls.some(c => c.path.includes('/pages/2')));
  assert.deepEqual(r.scope.excludedIds, ['2']);
});
test('partial body failures and drift remain visible without orphan claims', async () => {
  for (const kind of ['missing', 'http', 'drift', 'space', 'labels']) {
    let reads = 0;
    const {session} = harness([page()], spec => {
      if (!spec.path.includes('/pages/1')) return;
      if (kind === 'http') throw Object.assign(new Error('PRIVATE SERVER MESSAGE'), {status:403});
      if (spec.path.includes('/labels')) return kind === 'labels' ? {} : undefined;
      reads++;
      if (kind === 'missing') return {...page(), body:{}};
      if (reads > 1) return {...page(), ...(kind === 'space' ? {spaceId:'8'} : {version:{number:4}})};
    });
    const r = await scanDrainage(session, opts);
    assert.equal(r.inventory.status, 'partial', kind);
    assert.equal(r.graph, 'not-evaluated');
    assert.equal(r.inventory.errors.length, 1);
    assert.ok(!JSON.stringify(r).includes('PRIVATE SERVER MESSAGE'));
  }
});
test('only code-bound observations need a valid original revision', async () => {
  const pages = [page('1', '<p>Code: src/queue.mts</p>', ['type-observation']),
    page('2', '<p>Revision: dirty-tree</p><p>Code: src/queue.mts</p>', ['type-observation']),
    page('3', '<p>Revision: alpha@'+ 'a'.repeat(40) +'</p><p>Code: src/queue.mts</p>', ['type-observation']),
    page('4', '<p>General historical observation</p>', ['type-observation']), page('5')];
  const r = await scanDrainage(harness(pages).session, opts);
  assert.deepEqual(r.candidates.filter(c => c.problem === 'revision-missing-or-invalid').map(c => c.pageId), ['1','2']);
});
// Issue #650: the scanner and the confirm re-check share one classifier, which reads the claim without broker blocks.
const sha = 'a'.repeat(40);
const block = (command: string, date = '2026-10-22', measuredRevision?: string) => renderMeasurementBlock(
  { outcome: 'confirmed', reason: 'measured', labelsAdd: [], labelsRemove: [], ...(measuredRevision ? { measuredRevision } : {}) },
  { kind: measuredRevision ? 'code' : 'tracker', source: 'KEY-12', sourceClass: 'tracker', command, excerpt: 'key: KEY-12\nstate: Done',
    measuredAt: date, verdict: 'reproduces' }, 'runtime-claude-code-win');
const tracker = '<p>Tracker: KEY-12 holds the queue retry fix.</p>';
const confirmedLabels = ['type-observation','evidence-confirmed'];
const assumedLabels = ['type-observation','evidence-assumed'];
async function revisionIds(pages: ReturnType<typeof page>[]) {
  const scanned = (await scanDrainage(harness(pages).session,opts)).candidates
    .filter(c => c.problem === 'revision-missing-or-invalid').map(c => c.pageId);
  const direct = drainageRules(pages.map(p => ({id:p.id,version:3,title:p.title,spaceId:'9',parentId:null,body:p.body.storage.value,labels:p.labels})),false)
    .filter(c => c.problem === 'revision-missing-or-invalid').map(c => c.pageId);
  assert.deepEqual(scanned, direct, 'the scanner and the decide re-check run the same classifier');
  return scanned;
}
test('#650 T7: a measurement block never makes a page code-bound; original code still needs its Revision', async () => {
  assert.deepEqual(await revisionIds([
    page('1', tracker + block('node tools/atl-jira-ccoder.mts get --key KEY-12') + '<h2>Related pages</h2>', confirmedLabels),
    page('2', '<h2>Measurement 2026-10-22</h2><p>Code: src/queue.mts</p>' + tracker, assumedLabels),
    page('3', `<p>Revision: alpha@${sha}</p><p>Code: src/queue.mts</p>` + block(`git show ${sha}:src/retry.mts`, '2026-10-22', `alpha@${sha}`), confirmedLabels),
  ]), ['2']);
});
test('#650: two appended blocks hide nothing between them', async () => {
  const one = block('node tools/atl-jira-ccoder.mts get --key KEY-12');
  const two = block('node tools/jira.js get --key KEY-12', '2026-10-21');
  assert.deepEqual(await revisionIds([page('1', tracker + one + two, confirmedLabels),
    page('2', tracker + one + '<p>Code: src/queue.mts</p>' + two, confirmedLabels)]), ['2']);
});
test('#666: the scanner sees a block-shaped section inside the author text', async () => {
  const forged = block('jira get --key KEY-12').replace('<pre>key: KEY-12\nstate: Done</pre>', '<pre>Code: src/queue.mts retries on receipt</pre>');
  assert.deepEqual(await revisionIds([page('1', tracker + forged + '<p>Operators track the fix in KEY-12.</p>', assumedLabels),
    page('2', tracker + forged, assumedLabels)]), ['1']);
});
test('footer boilerplate is not duplicate evidence, substantial shared content is', async () => {
  const footer = '<h2>Related</h2><p>' + body.repeat(5) + '</p>';
  const r = await scanDrainage(harness([page('1','<p>Alpha</p>'+footer),page('2','<p>Beta</p>'+footer),page('3',body.repeat(3)),page('4',body.repeat(3))]).session, opts);
  assert.deepEqual(r.candidates.filter(c => c.problem === 'possible-near-duplicate').map(c => [c.pageId,c.relatedPageId]), [['3','4']]);
});
test('historical fixes are never refutations and status needs live verification', async () => {
  const r = await scanDrainage(harness([page('1','<p>Measured failure in release 1. Later fixed in release 2. TASK-123 is done.</p>')]).session, opts);
  assert.ok(r.candidates.some(c => c.problem === 'tracker-status-needs-verification' && c.uncertainty === 'UNKNOWN'));
  assert.ok(!JSON.stringify(r).includes('refute'));
});
test('explicit search-only link justification is a candidate', async () => {
  const r = await scanDrainage(harness([page('1','<p>Linked only because search returned it.</p>')]).session, opts);
  assert.ok(r.candidates.some(c => c.problem === 'search-only-link-justification'));
});
test('malformed, stalled, looping and escaping inventories reject visibly', async () => {
  for (const data of [{}, {results:[null]}, {results:[{id:'1'}]},
    {results:[],_links:{next:'/api/v2/spaces/9/pages?cursor=x'}},
    {results:[page()],_links:{next:'https://evil.example/api/v2/spaces/9/pages'}},
    {results:[page()],_links:{next:'/api/v2/spaces/8/pages?cursor=x'}},
    {results:[page()],_links:{next:'/api/v2/spaces/9/pages?cursor=x'}}]) {
    const {session} = harness([], () => data);
    await assert.rejects(() => spaceIndex(session,'9'));
    const report = await scanDrainage(session,opts);
    assert.notEqual(report.inventory.status,'complete');
    assert.equal(report.graph,'not-evaluated');
  }
});
test('expected version refuses stale or invalid review without PUT', async () => {
  for (const expected of [2,0,-1,NaN,1.5]) {
    const calls: RequestSpec[] = [];
    const session: ConfluenceSession = {async request(s) {calls.push(s); return {status:200,json:page()};}};
    await assert.rejects(() => updatePage(session,{id:'1',representation:'storage',value:body,expectedVersion:expected}));
    assert.ok(!calls.some(c => c.method === 'PUT'));
  }
});
test('guarded update sends expected plus one and verifies target bytes', async () => {
  for (const mismatch of [false,true]) {
    const calls: RequestSpec[] = [];
    const session: ConfluenceSession = {async request(s) {calls.push(s); return {status:200,json:calls.length === 1 ? page() : {...page(),version:{number:4},body:{storage:{value:mismatch ? 'wrong' : body}}}};}};
    const run = () => updatePage(session,{id:'1',representation:'storage',value:body,expectedVersion:3});
    if (mismatch) await assert.rejects(run,/readback/i); else assert.equal((await run()).sentVersion,4);
    assert.equal((calls[1].body as {version:{number:number}}).version.number,4);
    assert.equal(calls[2].method,'GET');
  }
});

test('full-space pagination reads each page and records a terminal inventory HTTP failure', async () => {
  const first = {results:[page('1')],_links:{next:'/api/v2/spaces/9/pages?cursor=two'}};
  const {session,calls} = harness([page('1'),page('2')], spec => {
    if (spec.path.includes('/spaces/9/pages')) return spec.path.includes('cursor=two') ? {results:[page('2')]} : first;
  });
  const result = await scanDrainage(session,opts);
  assert.equal(result.inventory.discovered,2);
  assert.equal(result.inventory.read,2);
  assert.equal(result.inventory.status,'complete');
  assert.equal(calls.filter(c=>c.path.includes('cursor=two')).length,2);
  const failed = harness([page()], spec => {
    if (spec.path.includes('/spaces/9/pages')) {
      if (spec.path.includes('cursor=two')) throw Object.assign(new Error('private'),{status:403});
      return first;
    }
  });
  const partial = await scanDrainage(failed.session,opts);
  assert.equal(partial.inventory.status,'partial');
  assert.equal(partial.inventory.errors[0].httpStatus,403);
  assert.equal(partial.inventory.discovered,1);
});
test('metadata approval is required before any API access', async () => {
  const {session,calls} = harness();
  await assert.rejects(()=>scanDrainage(session,{...opts,metadataApproved:false}),/Classify/);
  assert.equal(calls.length,0);
});
test('label drift is detected even when the page version did not change', async () => {
  let reads=0;
  const {session} = harness([page()], spec => spec.path.includes('/labels') ? {results:[{name: ++reads === 1 ? 'first':'second'}]} : undefined);
  const result = await scanDrainage(session,opts);
  assert.equal(result.inventory.errors[0].reason,'snapshot-drift');
  assert.equal(result.graph,'not-evaluated');
});

test('published revision grammar accepts repo bindings and scoped assumed disclaimers', async () => {
  const sha = 'a'.repeat(40);
  const confirmed = ['type-observation','evidence-confirmed'];
  const assumed = ['type-observation','evidence-assumed'];
  const pages = [
    page('1',`<p>Revision: alpha@${sha}</p>`,confirmed),
    page('2',`<p>Revision: owner/alpha@${sha}</p><p>Revision: beta@${sha}</p>`,confirmed),
    page('3',`<p>Revision: ${sha}</p>`,confirmed),
    page('4',`<p>Revision: alpha@${sha} (no exact binding: dirty tree)</p>`,assumed),
    page('5','<p>Revision: none (no exact binding: no repository)</p>',assumed),
    page('6',`<p>Revision: alpha@${sha} (no exact binding: dirty tree)</p>`,confirmed),
    page('7','<p>Revision: none (no exact binding: no full commit SHA)</p>',confirmed),
    page('8',`<p>Revision: https://example.invalid/alpha@${sha}</p>`,confirmed),
    page('9','<p>Revision: alpha@HEAD</p>',assumed),
    page('10',`<p>Revision: alpha@${sha.toUpperCase()}</p>`,confirmed),
  ];
  const r = await scanDrainage(harness(pages).session,opts);
  assert.deepEqual(r.candidates.filter(c=>c.problem === 'revision-missing-or-invalid').map(c=>c.pageId).sort(),['10','3','6','7','8','9']);
});
test('GitHub issue wording and issue links require current status verification', async () => {
  const pages = [page('1','<p>GitHub issue #517 is open.</p>'),
    page('2','<p><a href="https://github.com/example/alpha/issues/12">The issue</a> is closed.</p>'),
    page('3','<p>GitHub issue #517 was closed in a historical release.</p>'),
    page('4','<p>Linked only because the search returned it.</p>'),
    page('5','<p>Linked only because search returned them.</p>')];
  const r = await scanDrainage(harness(pages).session,opts);
  assert.deepEqual(r.candidates.filter(c=>c.problem === 'tracker-status-needs-verification').map(c=>c.pageId),['1','2']);
  assert.ok(r.candidates.filter(c=>c.problem === 'tracker-status-needs-verification').every(c=>c.uncertainty === 'UNKNOWN'));
  assert.deepEqual(r.candidates.filter(c=>c.problem === 'search-only-link-justification').map(c=>c.pageId),['4','5']);
});

test('invalid next queries cannot turn a truncated inventory into a complete empty terminal read', async () => {
  for (const query of ['limit=0&cursor=x','limit=-1&cursor=x','cursor=','limit=250','cursor=x&cursor=y','cursor=x&status=current&status=trashed']) {
    let reads=0;
    const {session} = harness([], spec => {
      if (spec.path.includes('/spaces/9/pages')) return ++reads === 1
        ? {results:[page()],_links:{next:`/api/v2/spaces/9/pages?${query}`}} : {results:[]};
    });
    await assert.rejects(()=>spaceIndex(session,'9'),query);
    assert.equal(reads,1,'malformed next links must be refused before following them');
  }
});
// Issue #906: a code-bound label counts at a line start after horizontal blanks only.
test('#906 a code-bound label counts at a line start only', () => {
  const missing = (value: string) => drainageRules([{ id: '1', version: 3, title: 'Synthetic 1', spaceId: '9', parentId: null, body: value,
    labels: ['type-observation'] }], true).filter(c => c.problem === 'revision-missing-or-invalid').map(c => c.pageId);
  for (const value of ['<p>Code: x</p>', '<p>a</p><p>   repo : x</p>', '<p>Code-bound: yes</p>']) assert.deepEqual(missing(value), ['1'], value);
  assert.deepEqual(missing('<p>see Code: x</p>'), []);
  const started = performance.now();
  assert.deepEqual(missing('\n'.repeat(50_000)), []);
  assert.ok(performance.now() - started < 200, 'linear on a run of line ends');
});
