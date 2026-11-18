// Issue #965: the argument and record refusals of the evidence verb, each before any Confluence read
// or file write it guards. Injected session, git and files only (evidence-cli.fixture.mts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideArgs, harness, MEASUREMENT, prepareArgs, prepared } from './evidence-cli.fixture.mts';

const RECORD = '/synthetic/evidence/r.json';

test('prepare refuses a missing --id and an unknown --kind before any request', async () => {
  const h = harness();
  await assert.rejects(() => h.run({ ...prepareArgs, id: undefined }), /--id must be a numeric page id\./);
  await assert.rejects(() => h.run({ ...prepareArgs, kind: 'rumour' }), /--kind takes code, tracker, live or doc\./);
  assert.deepEqual([h.calls.length, h.files.size], [0, 0]);
});

test('decide refuses a malformed --max-age-days and a non-numeric --superseded-by before reading the record', async () => {
  const h = await prepared();
  await assert.rejects(() => h.run({ ...decideArgs, 'max-age-days': '1.5' }), /--max-age-days must be a whole number\./);
  await assert.rejects(() => h.run({ ...decideArgs, 'max-age-days': '-1' }), /--max-age-days must be a whole number\./);
  await assert.rejects(() => h.run({ ...decideArgs, 'superseded-by': 'abc', 'body-approved': undefined }), /--superseded-by must be a numeric page id\./);
  assert.equal(h.calls.length, 0);
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
});

test('decide refuses a record that holds no prepared page', async () => {
  const h = harness();
  h.files.set(RECORD, JSON.stringify({ pageId: '5', excluded: 'private', reason: 'private-no-local-route' }));
  h.files.set('/synthetic/evidence/m.json', JSON.stringify(MEASUREMENT));
  await assert.rejects(() => h.run(decideArgs), /--record holds no prepared page\./);
  assert.equal(h.calls.length, 0);
});

test('decide refuses a --superseded-by that differs from the measurement before any read', async () => {
  const h = await prepared(harness(), { ...MEASUREMENT, verdict: 'contradicts', supersededBy: '7' });
  await assert.rejects(() => h.run({ ...decideArgs, 'superseded-by': '8', 'body-approved': undefined }),
    /--superseded-by differs from supersededBy in the measurement\./);
  assert.equal(h.calls.length, 0);
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
});

test('verify refuses a record without a proposed change, a missing --body-file and an unreadable one', async () => {
  const fresh = await prepared();
  await assert.rejects(() => fresh.run({ mode: 'verify', record: RECORD, 'body-file': '/synthetic/evidence/b.xml' }),
    /--record holds no proposed change to verify\./);

  const h = await prepared();
  assert.equal(await h.run(decideArgs), 0);
  await assert.rejects(() => h.run({ mode: 'verify', record: RECORD }), /--body-file is missing\./);
  await assert.rejects(() => h.run({ mode: 'verify', record: RECORD, 'body-file': '/synthetic/evidence/none.xml' }),
    /--body-file is not readable\./);
  assert.equal(fresh.calls.length + h.calls.length, 0);
});

test('report refuses a missing --records', async () => {
  const h = harness();
  await assert.rejects(() => h.run({ mode: 'report' }), /--records is missing\./);
  await assert.rejects(() => h.run({ mode: 'report', records: ',' }), /--records is missing\./);
});

test('record refuses an unknown exclusion and a missing reason before writing', async () => {
  const h = harness();
  const base = { mode: 'record', id: '5', out: '/synthetic/evidence/x.json' };
  await assert.rejects(() => h.run({ ...base, excluded: 'secret', reason: 'private-no-local-route' }), /--excluded takes private or unavailable\./);
  await assert.rejects(() => h.run({ ...base, reason: 'private-no-local-route' }), /--excluded takes private or unavailable\./);
  await assert.rejects(() => h.run({ ...base, excluded: 'unavailable' }), /--reason must be a short slug/);
  await assert.rejects(() => h.run({ ...base, id: undefined, excluded: 'private', reason: 'x' }), /--id must be a numeric page id\./);
  assert.equal(h.files.size, 0);
});

test('a missing --mode is refused like an unknown one', async () => {
  const h = harness();
  await assert.rejects(() => h.run({}), /--mode takes prepare, decide, verify, report or record\./);
});
