// Issue #965: the argument and record refusals of the evidence verb, each before any Confluence read
// or file write it guards. Injected session, git and files only (evidence-cli.fixture.mts).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './atl-confluence-ccoder.mts';
import { reply, routed } from './broker-route.fixture.mts';
import { BODY, decideArgs, harness, LABELS, MEASUREMENT, prepareArgs, prepared } from './evidence-cli.fixture.mts';

const RECORD = '/synthetic/evidence/r.json';

test('prepare refuses a missing --id and an unknown --kind before any request', async () => {
  const h = harness();
  await assert.rejects(() => h.run({ ...prepareArgs, id: undefined }), /--id must be a numeric page id\./);
  await assert.rejects(() => h.run({ ...prepareArgs, kind: 'rumour' }), /--kind takes code, tracker, live or doc\./);
  // --space is optional for the verb but not for prepare: an absent key is refused, not looked up.
  await assert.rejects(() => h.run({ ...prepareArgs, space: undefined }), /--space must be a Confluence space key\./);
  assert.deepEqual([h.calls.length, h.files.size], [0, 0]);
});

test('a hand-written record without labels, version or space decides from empty defaults and cannot be verified', async () => {
  const h = await prepared();
  const record = JSON.parse(h.files.get(RECORD) ?? '{}');
  for (const key of ['labels', 'readVersion', 'spaceId', 'spaceKey']) delete record[key];
  h.files.set(RECORD, JSON.stringify(record));
  assert.equal(await h.run(decideArgs), 0);
  assert.deepEqual(h.out.slice(-4), ['outcome: confirmed', 'reason: measured', 'labels: +evidence-confirmed / -evidence-assumed', 'body: written']);
  // No labels were recorded, so the proposal is the outcome label plus this host's runtime label.
  const after: string[] = JSON.parse(h.files.get(RECORD) ?? '{}').labelsAfter;
  assert.equal(after.length, 2);
  assert.equal(after[0], 'evidence-confirmed');
  assert.match(after[1], /^runtime-/);
  await assert.rejects(() => h.run({ mode: 'verify', record: RECORD, 'body-file': '/synthetic/evidence/b.xml' }),
    /Readback failed: [a-z-]+\. Result UNVERIFIED\./);
});

test('verify names the evidence labels, or none, when the reviewed set matches but the outcome label is missing', async () => {
  const decided = await prepared();
  assert.equal(await decided.run(decideArgs), 0);
  const check = async (labels: string[]) => {
    const v = harness({ '1': { body: BODY, labels } });
    for (const [k, value] of decided.files) v.files.set(k, value);
    v.files.set('/synthetic/evidence/same.xml', BODY);
    v.files.set(RECORD, JSON.stringify({ ...JSON.parse(decided.files.get(RECORD) ?? '{}'), labelsAfter: labels }));
    return [await v.run({ mode: 'verify', record: RECORD, 'body-file': '/synthetic/evidence/same.xml' }), v.out.at(-1)];
  };
  assert.deepEqual(await check(LABELS), [2, 'readback: mismatch labels (evidence-assumed)']);
  assert.deepEqual(await check(['status-author-model', 'type-observation']), [2, 'readback: mismatch labels (none)']);
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

test('decide on a measurement that is not an object is unknown and writes no body', async () => {
  const h = await prepared(harness(), null as unknown as object);
  assert.equal(await h.run(decideArgs), 2);
  assert.deepEqual(h.out.slice(-4), ['outcome: unknown', 'reason: measurement-incomplete', 'labels: none', 'body: not written']);
  assert.equal(h.files.has('/synthetic/evidence/b.xml'), false);
});

test('decide with a repo root outside any repository cannot verify the revision', async () => {
  const h = await prepared();
  assert.equal(await h.run({ ...decideArgs, 'repo-root': '/nowhere/alpha' }), 2);
  assert.deepEqual(h.out.slice(-4), ['outcome: unknown', 'reason: revision-not-verified', 'labels: none', 'body: not written']);
  assert.deepEqual(h.execs.at(-2), ['git', '-C', '/nowhere/alpha', 'rev-parse', '--show-toplevel']);
});

test('prepare through the broker refuses a space the account cannot see', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-cli-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const err: string[] = [];
  const { calls, fetchImpl } = routed([['GET', /\/spaces\?keys=ZZ$/, reply(200, { results: [] })]], [
    ['POST', /auth\.atlassian\.com/, reply(200, { access_token: 'synthetic-token', expires_in: 3600 })],
    ['GET', /_edge\/tenant_info$/, reply(200, { cloudId: 'synthetic-cloud' })],
  ]);
  const code = await runCli(['evidence', '--mode', 'prepare', '--id', '1', '--space', 'ZZ', '--out', path.join(home, 'r.json'), '--body-approved'], {
    env: { KHEREP_ATL_SITE: 'https://wiki.example.com', KHEREP_ATL_CRED_FILE_CLAUDE: 'synthetic-credential-path' },
    readFile: async () => 'Client ID: synthetic-client\nSecret: synthetic-secret-1234\n',
    fetch: fetchImpl, log: () => {}, logError: line => err.push(line),
  });
  assert.equal(code, 1, err.join('\n'));
  assert.deepEqual(err, ['No space with that key is visible to the service account.']);
  assert.equal(calls.some(call => call.url.includes('/pages/')), false);
  assert.equal(fs.existsSync(path.join(home, 'r.json')), false);
});
