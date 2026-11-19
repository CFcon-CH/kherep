import test from 'node:test';
import assert from 'node:assert/strict';
import { checkObsResult } from './obs-result-policy.mts';
import { OBS_WHY, obsWhy } from '../../modules/atl-jira-brokers/observation-result.mts';
test('accepts exact bounded publication receipts and preserves partial failure', () => {
    assert.deepEqual(checkObsResult('OBS-RESULT: wrote 2 123,456'), { status: 'wrote', ids: ['123', '456'] });
    assert.deepEqual(checkObsResult('OBS-RESULT: empty no-admissible-findings'), { status: 'empty', ids: [] });
    assert.deepEqual(checkObsResult('OBS-RESULT: failed readback-unverified created=123'), { status: 'failed', ids: ['123'] });
});
test('rejects candidates, fences, duplicates, count mismatch and arbitrary error text', () => {
    for (const text of ['{"observations":[]}', '```\nOBS-RESULT: empty no-admissible-findings\n```',
        'OBS-RESULT: wrote 2 123', 'OBS-RESULT: wrote 2 123,123', 'OBS-RESULT: failed secret/path',
        'OBS-RESULT: empty broker-unavailable', 'OBS-RESULT: wrote 0', 'OBS-RESULT: wrote 1 123\nextra']) {
        assert.ok('problem' in checkObsResult(text), text);
    }
});

for (const code of ['space-lookup-unavailable', 'space-unresolved', 'space-lookup-bindings-missing',
    'space-lookup-network-unavailable', 'space-lookup-timeout']) test(`fixed lookup receipt ${code} stays strict`, () => {
    assert.deepEqual(checkObsResult(`OBS-RESULT: failed ${code}`), { status: 'failed', ids: [] });
    assert.deepEqual(checkObsResult(`OBS-RESULT: failed ${code} created=123`), { status: 'failed', ids: ['123'] });
    assert.ok('problem' in checkObsResult(`OBS-RESULT: failed ${code}-CANARY`));
});

// Issue #989: links-refused and invalid-request name their findings and fixed codes.
const LINK_CODES = OBS_WHY['links-refused'];
for (const code of LINK_CODES) test(`links-refused why code ${code} is accepted`, () => {
    const line = `OBS-RESULT: failed links-refused why=3:${code}`;
    assert.deepEqual(checkObsResult(line), { status: 'failed', ids: [], why: `3:${code}` });
});
test('whole-line why=unknown, the reason-only invalid request and a full 40-entry line are accepted', () => {
    assert.deepEqual(checkObsResult('OBS-RESULT: failed links-refused why=unknown'), { status: 'failed', ids: [], why: 'unknown' });
    assert.deepEqual(checkObsResult('OBS-RESULT: failed invalid-request why=1:reason-invalid,4:reason-invalid'),
        { status: 'failed', ids: [], why: '1:reason-invalid,4:reason-invalid' });
    const why = Array.from({ length: 20 }, (_, i) => `${i + 1}:another-title,${i + 1}:not-candidate`).join(',');
    assert.deepEqual(checkObsResult(`OBS-RESULT: failed links-refused why=${why}`), { status: 'failed', ids: [], why });
    assert.deepEqual(checkObsResult('OBS-RESULT: failed links-refused'), { status: 'failed', ids: [] }, 'a pre-#989 bare line stays valid');
});
test('rejects a why suffix that is not one canonical fixed-code list', () => {
    for (const why of ['1:CANARY', '1:secret-path', '0:another-title', '21:another-title', '01:another-title', '2:another-title,1:another-title',
        '1:not-candidate,1:another-title', '1:another-title,1:another-title', '1:another-turn,1:another-title,1:not-candidate',
        '1:another-title,', ',1:another-title', '1:Another-Title', 'another-title', '1-another-title', '1:another-title 2:not-candidate',
        'unknown,1:another-title', '1:another-title,unknown', `1:${'a'.repeat(900)}`])
        assert.ok('problem' in checkObsResult(`OBS-RESULT: failed links-refused why=${why}`), why);
    for (const line of ['OBS-RESULT: failed links-refused why=1:another-title created=123', 'OBS-RESULT: failed links-refused created=123 why=1:another-title',
        'OBS-RESULT: failed authority-denied why=unknown', 'OBS-RESULT: failed authority-denied why=1:another-title',
        'OBS-RESULT: failed invalid-request why=1:another-title', 'OBS-RESULT: failed invalid-request why=unknown',
        'OBS-RESULT: failed invalid-request why=1:reason-invalid,1:reason-invalid', 'OBS-RESULT: failed links-refused why=',
        'OBS-RESULT: wrote 1 123 why=unknown', 'OBS-RESULT: empty no-admissible-findings why=unknown'])
        assert.ok('problem' in checkObsResult(line), line);
});
test('obsWhy renders the canonical form: by position, vocabulary order, no duplicates, two codes per finding', () => {
    assert.equal(obsWhy('links-refused', [{ position: 2, code: 'not-candidate' }, { position: 1, code: 'reason-invalid' },
        { position: 2, code: 'another-turn' }, { position: 2, code: 'another-turn' }, { position: 2, code: 'another-title' }, { position: 1, code: 'CANARY' }]),
    '1:reason-invalid,2:another-turn,2:another-title');
    assert.equal(obsWhy('invalid-request', [{ position: 1, code: 'another-title' }]), '');
    assert.equal(obsWhy('authority-denied', [{ position: 1, code: 'another-title' }]), '');
});
