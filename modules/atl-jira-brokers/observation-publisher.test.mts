import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishObservations, type ObservationBroker, type Target } from './observation-publisher.mts';
import { receiptStore } from './observation-receipt.mts';
const finding = { title: 'Synthetic transport measurement', bodyStorage: '<p>Origin: measured synthetic test -> pass</p>',
    evidence: 'assumed', labels: ['type-observation', 'evidence-assumed', 'status-author-model'], placement: { project: 'Kherep', app: '-' }, links: { candidates: 'a'.repeat(64), approved: [] as { id: string; reason: string }[] } };
const request = () => ({ sessionId: 'synthetic-session', turnId: 'turn-1', observations: [structuredClone(finding)] });
function fixture(t: {
    after(fn: () => void): void;
}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const calls: string[] = [];
    let target: Target;
    const broker: ObservationBroker = {
        runtimeLabel: 'runtime-codex-mac',
        authority: async () => { calls.push('authority'); return { observationPublishingAuthorized: true, spaceKey: 'SYNTHETIC', spaceId: '10', nodes: { Kherep: '20' } }; },
        space: async () => { calls.push('space'); return { id: '10', key: 'SYNTHETIC' }; },
        identity: async () => { calls.push('identity'); return 'service-synthetic'; },
        links: async () => { calls.push('links'); return { approved: [], reviewed: 0 }; },
        parent: async (_space, node) => { calls.push('parent'); return node; },
        related: async (_space, _key, f) => { calls.push('related'); return f.bodyStorage; },
        create: async (space, f, parent, body) => {
            calls.push('create');
            target = { id: String(100 + calls.filter(c => c === 'create').length), title: f.title,
                spaceId: space, parentId: parent, body, labels: [], authorId: 'service-synthetic' };
            return target.id;
        },
        labels: async (_id, labels) => { calls.push('labels'); target.labels = labels; },
        read: async () => { calls.push('read'); return target; },
        stitch: async () => { calls.push('stitch'); },
    };
    return { root, calls, broker, store: receiptStore(root) };
}
test('empty findings perform zero broker or receipt I/O', async (t) => {
    const f = fixture(t);
    const result = await publishObservations({ ...request(), observations: [] }, f.broker, { claim() { throw new Error('unexpected I/O'); } });
    assert.equal(result, 'OBS-RESULT: empty no-admissible-findings');
    assert.deepEqual(f.calls, []);
});
test('publishes once, readbacks before stitch, repeated and corrected requests never create duplicates', async (t) => {
    const f = fixture(t);
    const r = request();
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: wrote 1 101');
    assert.deepEqual(f.calls, ['authority', 'space', 'identity', 'links', 'parent', 'related', 'create', 'labels', 'read', 'stitch']);
    const calls = [...f.calls];
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: wrote 1 101');
    assert.deepEqual(f.calls, calls);
    r.observations[0].title = 'Correction';
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed receipt-conflict created=101');
    assert.deepEqual(f.calls, calls);
});
for (const grant of [undefined, false, 'true', null])
    test(`rejects nonliteral authority ${String(grant)}`, async (t) => {
        const f = fixture(t);
        f.broker.authority = async () => ({ observationPublishingAuthorized: grant, spaceKey: 'SYNTHETIC', spaceId: '10' });
        assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed authority-denied');
        assert.ok(!f.calls.includes('create'));
    });
for (const [member, expected] of [['authority', 'authority-unavailable'], ['space', 'space-lookup-unavailable'], ['identity', 'identity-unavailable'],
    ['parent', 'placement-unresolved'], ['related', 'related-unavailable'], ['create', 'create-unverified'], ['labels', 'labels-unverified'],
    ['read', 'readback-unverified'], ['stitch', 'stitch-unverified']] as const)
    test(`safe failure during ${member} is terminal`, async (t) => {
        const f = fixture(t);
        Object.assign(f.broker, { [member]: async () => { throw new Error('CANARY_SECRET_PRIVATE_PATH'); } });
        const first = await publishObservations(request(), f.broker, f.store);
        const created = ['labels', 'read', 'stitch'].includes(member) ? ' created=101' : '';
        assert.equal(first, `OBS-RESULT: failed ${expected}${created}`);
        assert.equal(await publishObservations(request(), f.broker, f.store), first);
        assert.doesNotMatch(fs.readdirSync(f.root).filter(n => n.endsWith('.json')).map(n => fs.readFileSync(path.join(f.root, n), 'utf8')).join(), /CANARY/);
        assert.ok(f.calls.filter(c => c === 'create').length <= 1);
    });
test('changed resolved space and unavailable trusted identity fail before create', async (t) => {
    const f = fixture(t);
    f.broker.space = async () => ({ id: '999', key: 'SYNTHETIC' });
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed space-mismatch');
    assert.ok(!f.calls.includes('create'));
    const r = request();
    r.turnId = 'turn-2';
    f.broker.space = async () => ({ id: '10', key: 'SYNTHETIC' });
    f.broker.identity = async () => null;
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed identity-unavailable');
    assert.ok(!f.calls.includes('create'));
});
for (const field of ['authorId', 'spaceId', 'parentId', 'body', 'title', 'labels'] as const)
    test(`checks target ${field}`, async (t) => {
        const f = fixture(t);
        const read = f.broker.read;
        f.broker.read = async (id) => ({ ...await read(id), [field]: field === 'labels' ? [] : 'wrong' });
        assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed readback-unverified created=101');
        assert.ok(!f.calls.includes('stitch'));
    });
// Issue #710: an id that is not a page id never reaches stitch.
for (const id of ['', 'abc'])
    test(`create returning ${JSON.stringify(id)} fails before stitch`, async (t) => {
        const f = fixture(t);
        f.broker.create = async () => { f.calls.push('create'); return id; };
        assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed create-unverified');
        assert.ok(!f.calls.includes('stitch'));
    });
test('unknown placement and injected controls are rejected without I/O', async (t) => {
    const f = fixture(t);
    for (const r of [{ ...request(), spaceId: '999' }, { ...request(), sessionId: '../path' },
        { ...request(), namedNode: 'Unknown' }, { ...request(), observations: [{ ...finding, bodyStorage: '<a href="https://private.invalid">secret</a>' }] }]) {
        assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed invalid-request');
    }
    assert.deepEqual(f.calls, []);
});
test('named node overrides all findings; partial creation retains IDs without a retry', async (t) => {
    const f = fixture(t);
    const r = request();
    r.observations.push({ ...finding, placement: { project: 'Operations', app: 'Do not guess' } });
    r.observations[1].title = 'Second';
    const original = f.broker.create;
    f.broker.create = async (...args) => { if (f.calls.includes('create'))
        throw new Error('timeout CANARY'); return original(...args); };
    assert.equal(await publishObservations({ ...r, namedNode: 'Kherep' }, f.broker, f.store), 'OBS-RESULT: failed create-unverified created=101');
    assert.equal(f.calls.filter(c => c === 'create').length, 1);
});

for (const [space, code] of [
    [null, 'space-unresolved'], [{ id: '999', key: 'SYNTHETIC' }, 'space-mismatch'],
    [{ id: '10', key: 'OTHER' }, 'space-lookup-unavailable'], [{ id: '10', key: 'SYNTHETIC_EXTRA' }, 'space-lookup-unavailable'], [{ id: 'CANARY', key: 'SYNTHETIC' }, 'space-lookup-unavailable'],
] as const) test(`space lookup distinguishes ${code} for ${JSON.stringify(space)}`, async t => {
    const f = fixture(t);
    let lookups = 0;
    f.broker.space = async () => { lookups++; return space; };
    const result = await publishObservations(request(), f.broker, f.store);
    assert.equal(result, `OBS-RESULT: failed ${code}`);
    assert.equal(await publishObservations(request(), f.broker, f.store), result);
    assert.equal(lookups, 1);
    assert.deepEqual(f.calls, ['authority']);
});

for (const key of ['synthetic', ' SYNTHETIC ']) test(`canonical space key normalization preserves publication: ${key}`, async t => {
    const f = fixture(t);
    const authority = f.broker.authority;
    f.broker.authority = async () => ({ ...await authority(), spaceKey: key });
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: wrote 1 101');
    assert.equal(f.calls.filter(c => c === 'create').length, 1);
});
// Issue #736: links are checked for every finding before the first create. A
// refusal is terminal and writes nothing; its replay performs no broker I/O.
test('a refused link decision fails links-refused before any create', async (t) => {
    const f = fixture(t);
    const r = request();
    r.observations.push({ ...structuredClone(finding), title: 'Second' });
    let checked = 0;
    f.broker.links = async () => { f.calls.push('links'); if (++checked === 2) throw new Error('links-refused'); return { approved: [], reviewed: 0 }; };
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed links-refused');
    assert.deepEqual(f.calls, ['authority', 'space', 'identity', 'links', 'links']);
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed links-refused');
    assert.equal(f.calls.length, 5);
});
