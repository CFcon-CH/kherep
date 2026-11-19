// Issue #736 replayed for the Codex adapter. A new page W ("Synthetic logon
// task workaround for the agent account state") got backlinks from two
// off-topic pages A and B that share title words with it. The fake search
// answers in the measured ranking: on the topic sentence the on-topic pages
// C1-C4 come first. codex-obs approves C1 and C2; only those are linked.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { observationRpc } from './observation-stdio.mts';
import { observationLinking, type LinkingContext } from './observation-linking.mts';
import type { Finding } from './observation-policy.mts';
import { publishObservations } from './observation-publisher.mts';
import { candidates, finding, fixture, PAGES, publish, R1, R2, RANKING, TOPIC, W, type Fixture } from './observation-linking.fixture.mts';

test('the candidates call writes nothing and returns rows plus a token', async t => {
    const f = fixture(t);
    const { out, token } = await candidates(f);
    assert.equal(out.isError, false);
    const lines = out.text.split('\n');
    assert.equal(lines[0], `OBS-CANDIDATES: ok ${token} 5`);
    assert.deepEqual(lines.slice(1).map(line => line.split('\t')[1]), RANKING);
    assert.deepEqual(lines[1].split('\t'), ['candidate', '51', PAGES[2].title, 'Kherep', 'task,logon', `${PAGES[2].title}.`]);
    assert.deepEqual(f.writes(), []);
    assert.equal(fs.existsSync(path.join(f.home, 'receipts')), false, 'the journal is never touched');
    const receipt = JSON.parse(fs.readFileSync(path.join(f.dir, `${token}.json`), 'utf8'));
    assert.deepEqual([receipt.kind, receipt.source, receipt.sessionId, receipt.turnId], ['related-candidates', { title: W }, 'synthetic', 'turn']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.dir, `${token}.json`)).mode & 0o777, 0o600);
});

test('approving {C1, C2} links only C1 and C2, with the reasons in the version messages', async t => {
    const f = fixture(t);
    const { token } = await candidates(f);
    const result = await publish(f, { candidates: token, approved: [{ id: '51', reason: R1 }, { id: '52', reason: R2 }] });
    assert.equal(result, 'OBS-RESULT: wrote 1 100');
    assert.deepEqual(f.writes(), ['POST /wiki/api/v2/pages', 'POST /wiki/rest/api/content/100/label', 'PUT /wiki/api/v2/pages/51', 'PUT /wiki/api/v2/pages/52']);
    const puts = f.calls.filter(c => c.method === 'PUT');
    assert.deepEqual(puts.map(c => c.body.version.message), [`observation link: ${R1}`, `observation link: ${R2}`]);
    const created = f.calls.find(c => c.method === 'POST' && c.route === '/wiki/api/v2/pages')!.body.body.value as string;
    assert.match(created, /<h2>Related pages<\/h2><ul><li><p><a href="\/wiki\/spaces\/SYNTHETIC\/pages\/51">.*pages\/52">/);
    assert.doesNotMatch(created, /pages\/4[12]"/, 'no off-topic page is linked');
    assert.match(f.pages.get('51')!.body.storage.value, /pages\/100"/);
    assert.doesNotMatch(f.pages.get('41')!.body.storage.value, /pages\/100"/);
});

test('an id outside the receipt and an unknown token are links-refused with zero POST or PUT', async t => {
    const f = fixture(t);
    const { token } = await candidates(f);
    assert.equal(await publish(f, { candidates: token, approved: [{ id: '42', reason: 'Shares the word state with W.' }] }), 'OBS-RESULT: failed links-refused why=1:not-candidate');
    assert.equal(await publish(f, { candidates: 'b'.repeat(64), approved: [] }, 'turn-2'), 'OBS-RESULT: failed links-refused why=1:receipt-missing');
    assert.deepEqual(f.writes(), []);
});

test('a token from another turn, space or title, or older than 2 h, is refused', async t => {
    const f = fixture(t);
    const other = await candidates(f, { turnId: 'other-turn' });
    assert.equal(await publish(f, { candidates: other.token, approved: [] }, 'turn-a'), 'OBS-RESULT: failed links-refused why=1:another-turn');
    const titled = await candidates(f, { title: 'A different observation title' });
    assert.equal(await publish(f, { candidates: titled.token, approved: [] }, 'turn'), 'OBS-RESULT: failed links-refused why=1:another-title');
    for (const [turn, change, code] of [['turn-b', { spaceKey: 'OTHER' }, 'another-space'],
        ['turn-c', { searchedAt: new Date(Date.now() - 2 * 3600_000 - 1000).toISOString() }, 'receipt-expired']] as const) {
        const { token } = await candidates(f, { turnId: turn });
        const file = path.join(f.dir, `${token}.json`);
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change }));
        assert.equal(await publish(f, { candidates: token, approved: [] }, turn), `OBS-RESULT: failed links-refused why=1:${code}`, turn);
    }
    assert.deepEqual(f.writes(), []);
});

// Issue #989: why a receipt cannot be used, as a fixed code per finding.
const errno = (code: string) => Object.assign(new Error(`${code} CANARY_PRIVATE_PATH`), { code });
for (const [code, expected] of [['ENOENT', 'receipt-missing'], ['ENOTDIR', 'receipt-missing'], ['EACCES', 'receipt-unreadable'],
    ['EBUSY', 'receipt-unreadable'], ['EPERM', 'receipt-unreadable']] as const)
    for (const member of ['lstatSync', 'readFileSync'] as const) test(`${member} failing with ${code} is ${expected}`, async t => {
        const f = fixture(t);
        const { token } = await candidates(f);
        const original = fs[member] as (...args: unknown[]) => unknown;
        const spy = mock.method(fs, member, (...args: unknown[]) => {
            if (String(args[0]).endsWith(`${token}.json`)) throw errno(code);
            return original(...args);
        });
        t.after(() => spy.mock.restore());
        assert.equal(await publish(f, { candidates: token, approved: [] }), `OBS-RESULT: failed links-refused why=1:${expected}`);
        assert.deepEqual(f.writes(), []);
    });
test('an unreadable candidates directory is receipt-unreadable, never missing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
    const f = fixture(t);
    const { token } = await candidates(f);
    fs.chmodSync(f.dir, 0o000);
    try {
        assert.equal(await publish(f, { candidates: token, approved: [] }), 'OBS-RESULT: failed links-refused why=1:receipt-unreadable');
    } finally { fs.chmodSync(f.dir, 0o700); }
});
test('a directory, a symlink, an oversize or a garbage file at the token path is receipt-malformed', async t => {
    const f = fixture(t);
    const { token: real } = await candidates(f);
    const make: [string, (file: string) => void][] = [['dir', file => fs.mkdirSync(file)], ['garbage', file => fs.writeFileSync(file, 'not json')],
        ['oversize', file => fs.writeFileSync(file, ' '.repeat(512 * 1024 + 1))], ['wrong-kind', file => fs.writeFileSync(file, '{"kind":"other"}')]];
    if (process.platform !== 'win32') make.push(['symlink', file => fs.symlinkSync(path.join(f.dir, `${real}.json`), file)]);
    for (const [index, [name, create]] of make.entries()) {
        const token = String(index + 1).repeat(64);
        create(path.join(f.dir, `${token}.json`));
        assert.equal(await publish(f, { candidates: token, approved: [] }, `turn-${name}`), 'OBS-RESULT: failed links-refused why=1:receipt-malformed', name);
    }
    assert.deepEqual(f.writes(), []);
});
async function twoFindings(f: Fixture, change?: (receipt: { candidates: { id: string }[] }) => void) {
    const first = await candidates(f), second = await candidates(f, { title: 'Second synthetic title' });
    if (change) {
        const file = path.join(f.dir, `${second.token}.json`), receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
        change(receipt);
        fs.writeFileSync(file, JSON.stringify(receipt));
    }
    return [first.token, second.token];
}
const pair = (f: Fixture, links: unknown[]) => publishObservations({ sessionId: 'synthetic', turnId: 'turn', observations: [
    finding(links[0]), { ...finding(links[1]), title: 'Second synthetic title' }] }, f.broker, f.store);
test('swapped tokens name both findings and an id from the other receipt is not-candidate', async t => {
    const f = fixture(t);
    const [one, two] = await twoFindings(f, receipt => { receipt.candidates = receipt.candidates.filter(c => c.id !== '51'); });
    assert.equal(await pair(f, [{ candidates: two, approved: [] }, { candidates: one, approved: [] }]),
        'OBS-RESULT: failed links-refused why=1:another-title,2:another-title');
    const g = fixture(t);
    const [three, four] = await twoFindings(g, receipt => { receipt.candidates = receipt.candidates.filter(c => c.id !== '51'); });
    assert.equal(await pair(g, [{ candidates: three, approved: [{ id: '51', reason: R1 }] }, { candidates: four, approved: [{ id: '51', reason: R1 }] }]),
        'OBS-RESULT: failed links-refused why=2:not-candidate');
    assert.deepEqual([...f.writes(), ...g.writes()], []);
});
test('a receipt dated more than 5 min ahead is receipt-future', async t => {
    const f = fixture(t);
    const { token } = await candidates(f);
    const file = path.join(f.dir, `${token}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), searchedAt: new Date(Date.now() + 10 * 60_000).toISOString() }));
    assert.equal(await publish(f, { candidates: token, approved: [] }), 'OBS-RESULT: failed links-refused why=1:receipt-future');
});

test('nothing approved writes the no-link sentence and makes zero PUTs', async t => {
    const f = fixture(t);
    const { token } = await candidates(f);
    assert.equal(await publish(f, { candidates: token, approved: [] }), 'OBS-RESULT: wrote 1 100');
    const created = f.calls.find(c => c.method === 'POST' && c.route === '/wiki/api/v2/pages')!.body.body.value as string;
    assert.match(created, /<h2>Related pages<\/h2><p>No related page on this topic \(5 candidates reviewed\)\.<\/p>$/);
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
});

test('a failed candidate search writes no receipt and publishes nothing', async t => {
    const f = fixture(t, { searchFails: true });
    const { out } = await candidates(f);
    assert.deepEqual(out, { text: 'OBS-CANDIDATES: failed related-unavailable', isError: true });
    assert.equal(fs.existsSync(f.dir) && fs.readdirSync(f.dir).length > 0, false);
    // codex-obs then publishes once with the all-zero token: UNKNOWN, nothing created.
    assert.equal(await publish(f, { candidates: '0'.repeat(64), approved: [] }), 'OBS-RESULT: failed related-unavailable');
    assert.deepEqual(f.writes(), []);
});

test('a topic inside the title and malformed input are refused before any request', async t => {
    const f = fixture(t);
    for (const input of [{ topic: 'logon task workaround' }, { topic: 'short' }, { sessionId: 'BAD ID' }, { extra: 'x' }]) {
        const out = await f.broker.candidates({ sessionId: 'synthetic', turnId: 'turn', title: W, topic: TOPIC, ...input });
        assert.deepEqual(out, { text: 'OBS-CANDIDATES: failed invalid-request', isError: true });
    }
    assert.deepEqual(f.calls, []);
});

test('an identical replay does no I/O and changed decisions are a receipt conflict', async t => {
    const f = fixture(t);
    const { token } = await candidates(f);
    const links = { candidates: token, approved: [{ id: '51', reason: R1 }] };
    assert.equal(await publish(f, links), 'OBS-RESULT: wrote 1 100');
    const count = f.calls.length;
    assert.equal(await publish(f, links), 'OBS-RESULT: wrote 1 100');
    assert.equal(f.calls.length, count);
    assert.equal(await publish(f, { ...links, approved: [{ id: '52', reason: R2 }] }), 'OBS-RESULT: failed receipt-conflict created=100');
    assert.equal(f.calls.length, count);
});

test('the stdio candidates tool answers through RPC and never touches the journal', async t => {
    const f = fixture(t);
    let published = 0;
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'related_candidates',
        arguments: { sessionId: 'synthetic', turnId: 'turn', title: W, topic: TOPIC } } };
    const response = await observationRpc(call, async () => { published++; return 'OBS-RESULT: empty no-admissible-findings'; },
        args => f.broker.candidates(args)) as any;
    assert.match(response.result.content[0].text, /^OBS-CANDIDATES: ok [a-f0-9]{64} 5\n/);
    assert.equal(response.result.isError, false);
    assert.equal(published, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'receipts')), false);
    const unwired = await observationRpc(call, async () => 'OBS-RESULT: empty no-admissible-findings') as any;
    assert.equal(unwired.error.message, 'method-unavailable');
});

// Issue #906: the prose escape keeps every <...> run (found in one pass) and escapes
// only the text between them. related() is called directly: the publish path refuses
// tag attributes and a dangling < before it gets here.
test('related prose escapes text between tags and keeps a quote inside a tag', async () => {
    const linking = observationLinking({} as LinkingContext);
    const prose = (body: string) => linking.related('KEY', { bodyStorage: body } as Finding, { approved: [], reviewed: 0 });
    const none = '<h2>Related pages</h2><p>No related page on this topic (0 candidates reviewed).</p>';
    for (const [body, expected] of [
        ['<p title="x">\u2018q\u2019</p>', '<p title="x">&lsquo;q&rsquo;</p>'],
        ['<p>a</p>tail "x" < y', '<p>a</p>tail &quot;x&quot; < y'],
        ['<p>a < b > c</p>', '<p>a < b > c</p>'],
    ]) assert.equal(await prose(body), expected + none, body);
    const started = performance.now();
    assert.equal(await prose('<"'.repeat(50_000)), '<&quot;'.repeat(50_000) + none);
    assert.ok(performance.now() - started < 200, 'linear on a run of < without >');
});
