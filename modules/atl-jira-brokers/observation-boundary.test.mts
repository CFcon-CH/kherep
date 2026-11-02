// Issue #730: real RPC output and SubagentStop boundaries, generated inputs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observationRpc } from './observation-stdio.mts';
import * as policy from './observation-result.mts';
import { receiptStore, receiptKey } from './observation-receipt.mts';
import { decide, OBS_RESULT_REASON } from '../../codex/hooks/obs-result-check.mts';
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish_observations', arguments: {} } };
const attempt = (reason: string, detail = 'unknown', publication = 'unknown', created = 'unknown') =>
    `OBS-ATTEMPT: failed ${reason} detail=${detail} publication=${publication} created=${created}`;
const handback = (text: string) => {
    assert.equal(typeof policy.checkObsHandback, 'function');
    return policy.checkObsHandback(text);
};
for (const receipt of ['OBS-RESULT: wrote 2 123,456', 'OBS-RESULT: empty no-admissible-findings',
    'OBS-RESULT: failed authority-denied', 'OBS-RESULT: failed readback-unverified created=123,456'])
    test(`canonical RPC receipt is preserved: ${receipt}`, async () => {
        let calls = 0;
        const response = await observationRpc(call, async () => { calls++; return receipt; }) as any;
        assert.equal(calls, 1);
        assert.equal(response.result.content[0].text, receipt);
        assert.equal(response.result.isError, receipt.startsWith('OBS-RESULT: failed'));
        assert.deepEqual(handback(receipt), policy.checkObsResult(receipt));
        const checked = decide({ agent_type: 'codex-obs', stop_hook_active: false, last_assistant_message: receipt });
        if (response.result.isError) {
            assert.ok(checked && 'systemMessage' in checked);
            assert.match(checked.systemMessage, /same turn/);
            assert.doesNotMatch(checked.systemMessage, /OBS-ATTEMPT/);
        } else assert.equal(checked, null);
    });
for (const output of ['OBS-RESULT: failed publication-rejected', 'OBS-RESULT: failed missing-turn-identity',
    'OBS-RESULT: wrote 2 123', 'OBS-RESULT: failed readback-unverified created=123,', 'CANARY_OUTPUT',
    attempt('tool-refused', 'unacceptable-risk'), null, { secret: 'CANARY_OUTPUT' }])
    test(`RPC refuses malformed publisher output without echo: ${JSON.stringify(output).slice(0, 80)}`, async () => {
        let calls = 0;
        const response = await observationRpc(call, async () => { calls++; return output as string; });
        assert.equal(calls, 1);
        assert.deepEqual(response, { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'publication-outcome-unknown' } });
        assert.doesNotMatch(JSON.stringify(response), /CANARY|created=|authority-denied|broker-unavailable/);
    });
test('publisher throw has no invented phase or IDs and invokes publication only once', async () => {
    let calls = 0;
    assert.deepEqual(await observationRpc(call, async () => { calls++; throw new Error('CANARY_PROVIDER'); }),
        { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'publication-outcome-unknown' } });
    assert.equal(calls, 1);
});
const tuples = [
    ['missing-turn-identity', 'none', 'not-attempted', 'none'], ['tool-unavailable', 'none', 'not-attempted', 'none'],
    ['tool-refused', 'unacceptable-risk'], ['tool-refused', 'unknown'], ['tool-error', 'unknown'],
    ...['invalid-request', 'invalid-parameters', 'method-unavailable', 'publication-outcome-unknown', 'unknown'].map(detail => ['protocol-error', detail]),
    ['invalid-tool-response', 'unknown'], ['evidence-unavailable', 'unknown'],
];
for (const [reason, detail, publication = 'unknown', created = 'unknown'] of tuples)
    test(`worker-only handback ${reason}/${detail} warns once without claiming an adapter receipt`, () => {
        const text = attempt(reason, detail, publication, created);
        assert.deepEqual(handback(text), { status: 'attempt-failed', reason, detail, publication, created });
        assert.ok('problem' in policy.checkObsResult(text));
        for (const stop_hook_active of [false, true]) {
            const result = decide({ agent_type: 'codex-obs', last_assistant_message: text, stop_hook_active });
            assert.ok(result && 'systemMessage' in result);
            assert.match(result.systemMessage, /non-adapter.*same turn/);
            assert.match(result.systemMessage, publication === 'unknown' ? /publication and created IDs are UNKNOWN/ : /not attempted/);
        }
    });
test('unknown tuples, extra fields and malformed IDs never become accepted worker handbacks', () => {
    for (const text of [attempt('tool-refused', 'CANARY_REASON'), attempt('tool-error', 'unknown', 'not-attempted', 'none'),
        attempt('tool-refused', 'unknown', 'unknown', 'none'), attempt('tool-unavailable'), attempt('constructor'), attempt('protocol-error', 'authority-denied'),
        `${attempt('tool-error')} created=123`, `${attempt('tool-error')}\nCANARY`, 'x'.repeat(1201)]) {
        assert.ok('problem' in handback(text));
        const result = decide({ agent_type: 'codex-obs', stop_hook_active: false, last_assistant_message: text });
        assert.deepEqual(result, { decision: 'block', reason: OBS_RESULT_REASON });
        assert.doesNotMatch(JSON.stringify(result), /CANARY/);
    }
    assert.match(OBS_RESULT_REASON, /evidence-unavailable/);
    assert.match(OBS_RESULT_REASON, /NO further publication/);
});
test('worker attempts in a durable journal are rejected, not converted into empty IDs or a retry', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-boundary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const key = receiptKey('synthetic', 'turn');
    fs.writeFileSync(path.join(root, `${key}.json`), JSON.stringify({ digest: 'a'.repeat(64), ids: [], result: attempt('tool-error') }));
    assert.throws(() => receiptStore(root).claim(key, 'a'.repeat(64)), /receipt-unavailable/);
});
