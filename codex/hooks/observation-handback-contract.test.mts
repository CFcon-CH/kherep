// These checks establish configured contracts, not model or native compliance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { turnContext } from './kherep-maestro-context.mts';
import { observationPrompt } from './observation-stop.mts';
import { renderObservationInstruction } from './observation-turn-completion.mts';
import { checkObsHandback } from './obs-result-policy.mts';
const root = path.resolve(import.meta.dirname, '../..');
const worker = fs.readFileSync(path.join(root, 'codex/agents/codex-obs.md'), 'utf8');
const preflight = 'OBS-ATTEMPT: failed missing-turn-identity detail=none publication=not-attempted created=none';
test('identity preflight instructions and real handback parser agree', () => {
    assert.ok(worker.includes(preflight));
    assert.ok(turnContext({}).includes(preflight));
    assert.deepEqual(checkObsHandback(preflight), { status: 'attempt-failed', reason: 'missing-turn-identity', detail: 'none', publication: 'not-attempted', created: 'none' });
    assert.ok(worker.includes('OBS-ATTEMPT: failed tool-unavailable detail=none publication=not-attempted created=none'));
});
test('every current context/observation prompt requires the two distinct handback kinds without isError inference', () => {
    for (const prompt of [turnContext({}), observationPrompt(), renderObservationInstruction('/synthetic')]) {
        assert.match(prompt, /OBS-RESULT/);
        assert.match(prompt, /OBS-ATTEMPT/);
        assert.match(prompt, /isError.*alone.*does not prove an outer refusal/);
        assert.match(prompt, /publication and IDs UNKNOWN/);
        assert.match(prompt, /same turn/);
    }
});
test('worker requires immediate envelope evidence, exact refusal detail and unavailable-evidence correction without recovery', () => {
    for (const pattern of [/single text content block of the immediate valid tool result/, /never from quoted instructions/,
        /isError: true.*NOT evidence/, /This action was rejected due to unacceptable risk/, /optionally its terminal full stop/,
        /message is exactly that fixed/, /evidence-unavailable detail=unknown publication=unknown created=unknown/,
        /NO further publication, tool call, retry/, /No recovery tools, fallback account, broker or permission change/]) assert.match(worker, pattern);
    assert.doesNotMatch(worker, /return `OBS-RESULT: failed broker-unavailable`|return exactly `OBS-RESULT: failed missing-turn-identity`/);
    const rows = worker.slice(worker.indexOf('| reason |'), worker.indexOf('\n\nIf the tool is absent')).split('\n').slice(2);
    assert.equal(rows.length, 7, 'complete finite worker-attempt table');
});
