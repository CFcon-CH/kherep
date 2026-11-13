// Issue #736 replayed for the Codex adapter. A new page W ("Synthetic logon
// task workaround for the agent account state") got backlinks from two
// off-topic pages A and B that share title words with it. The fake search
// answers in the measured ranking: on the topic sentence the on-topic pages
// C1-C4 come first. codex-obs approves C1 and C2; only those are linked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observationBroker } from './observation-broker.mts';
import { publishObservations } from './observation-publisher.mts';
import { receiptStore } from './observation-receipt.mts';
import { observationRpc } from './observation-stdio.mts';
import { observationLinking, type LinkingContext } from './observation-linking.mts';
import type { Finding } from './observation-policy.mts';
import type { ConfluenceContext } from './confluence-session.mts';

const W = 'Synthetic logon task workaround for the agent account state';
const PAGES = [
    { id: '41', title: 'Owner probe retry when the account lookup fails' },
    { id: '42', title: 'Codex session idle state after a switch' },
    { id: '51', title: 'Scheduled task does not start at logon' },
    { id: '52', title: 'Task trigger delay after logon' },
    { id: '53', title: 'Run a hook as the interactive user' },
    { id: '54', title: 'Session 0 isolation blocks the tray app' },
];
const RANKING = ['51', '52', '53', '54', '41'];
const TOPIC = 'A logon-triggered scheduled task never starts under the service account; running it as the interactive user fixes it.';
const R1 = 'Same logon-trigger task that never starts; this page has the root cause.';
const R2 = 'Documents the trigger delay the workaround has to tolerate at logon.';

function fixture(t: { after(fn: () => void): void }, options: { searchFails?: boolean } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-linking-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'kherep'));
    fs.writeFileSync(path.join(home, 'kherep', 'confluence.json'), JSON.stringify({
        observationPublishingAuthorized: true, spaceKey: 'SYNTHETIC', spaceId: '10', nodes: { Kherep: '20' } }));
    const pages = new Map(PAGES.map(p => [p.id, { ...p, spaceId: '10', parentId: '20', status: 'current', version: { number: 1 },
        body: { storage: { value: `<p>${p.title}</p>` } } }]));
    const calls: { method: string; route: string; body?: any }[] = [];
    let page: any;
    const labels: string[] = [];
    const context: ConfluenceContext = { env: { KHEREP_ATL_SITE: 'https://synthetic.invalid', KHEREP_ATL_CRED_FILE_CODEX: '/synthetic', KHEREP_PROFILE: 'mac' },
        credEnv: 'KHEREP_ATL_CRED_FILE_CODEX', readFile: async () => 'client_id: synthetic\nclient_secret: synthetic', now: Date.now, session: {},
        fetch: async (url, opts) => {
            const route = url.replace(/^https:\/\/api\.atlassian\.com\/ex\/confluence\/synthetic-cloud(?=\/|$)/, '');
            const method = opts?.method ?? 'GET';
            const body = opts?.body ? JSON.parse(opts.body.toString()) : undefined;
            calls.push({ method, route, body });
            const id = /^\/wiki\/api\/v2\/pages\/(\d+)/.exec(route)?.[1] ?? '';
            let json: any;
            if (url === 'https://auth.atlassian.com/oauth/token') json = { access_token: 'synthetic', expires_in: 3600 };
            else if (url.endsWith('/_edge/tenant_info')) json = { cloudId: 'synthetic-cloud' };
            else if (route === '/wiki/rest/api/user/current') json = { accountId: 'synthetic-service' };
            else if (route.startsWith('/wiki/api/v2/spaces?')) json = { results: [{ id: '10', key: 'SYNTHETIC', name: 'Synthetic' }] };
            else if (route.startsWith('/wiki/api/v2/spaces/10/pages?')) json = { results: [{ id: '20', title: 'Kherep' }, ...pages.values(), ...(page ? [page] : [])] };
            else if (route.startsWith('/wiki/rest/api/search?')) {
                if (options.searchFails) return { status: 503, ok: false, json: async () => ({}), text: async () => '{}' };
                json = { results: [] };
            }
            else if (route === '/wiki/api/v2/pages' && method === 'POST') {
                page = { id: '100', status: 'current', title: body.title, parentId: body.parentId, spaceId: body.spaceId, authorId: 'synthetic-service',
                    version: { number: 1 }, body: { storage: { value: body.body.value } } };
                json = page;
            }
            else if (route === '/wiki/api/v2/pages/20') json = { id: '20', spaceId: '10', title: 'Kherep', status: 'current' };
            else if (route.startsWith('/wiki/api/v2/pages/100/labels?')) json = { results: labels.map(name => ({ name })) };
            else if (route === '/wiki/rest/api/content/100/label' && method === 'POST') { labels.push(...body.map((v: any) => v.name)); json = { results: [] }; }
            else if (id === '100') json = page;
            else if (pages.has(id) && method === 'PUT') {
                pages.set(id, { ...pages.get(id)!, version: body.version, body: { storage: { value: body.body.value } } });
                json = pages.get(id);
            }
            else if (pages.has(id)) json = pages.get(id);
            else throw new Error(`Unexpected synthetic route: ${method} ${route}`);
            return { status: 200, ok: true, json: async () => json, text: async () => JSON.stringify(json) };
        } };
    const semantic = async () => {
        const items = RANKING.map(id => ({ id, title: pages.get(id)!.title, snippet: `<p>${pages.get(id)!.title}.</p>` }));
        return { titles: items.map(item => item.title), items };
    };
    const broker = observationBroker(home, context, { semantic });
    const dir = path.join(home, '.cache', 'observation-publisher', 'candidates');
    const writes = () => calls.filter(c => (c.method === 'POST' || c.method === 'PUT') && c.route.startsWith('/wiki/')).map(c => `${c.method} ${c.route}`);
    return { home, dir, calls, writes, broker, pages, store: receiptStore(path.join(home, 'receipts')) };
}
type Fixture = ReturnType<typeof fixture>;

const finding = (links: unknown) => ({ title: W, bodyStorage: '<p>Origin: measured synthetic logon test</p>', evidence: 'assumed',
    labels: ['type-observation', 'evidence-assumed', 'status-author-model'], placement: { project: 'Kherep', app: '-' }, links });
const publish = (f: Fixture, links: unknown, turnId = 'turn') =>
    publishObservations({ sessionId: 'synthetic', turnId, observations: [finding(links)] }, f.broker, f.store);
async function candidates(f: Fixture, overrides: Record<string, string> = {}) {
    const out = await f.broker.candidates({ sessionId: 'synthetic', turnId: 'turn', title: W, topic: TOPIC, ...overrides });
    return { out, token: /^OBS-CANDIDATES: ok ([a-f0-9]{64}) \d+/.exec(out.text)?.[1] ?? '' };
}

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
    assert.equal(await publish(f, { candidates: token, approved: [{ id: '42', reason: 'Shares the word state with W.' }] }), 'OBS-RESULT: failed links-refused');
    assert.equal(await publish(f, { candidates: 'b'.repeat(64), approved: [] }, 'turn-2'), 'OBS-RESULT: failed links-refused');
    assert.deepEqual(f.writes(), []);
});

test('a token from another turn, space or title, or older than 2 h, is refused', async t => {
    const f = fixture(t);
    const other = await candidates(f, { turnId: 'other-turn' });
    assert.equal(await publish(f, { candidates: other.token, approved: [] }, 'turn-a'), 'OBS-RESULT: failed links-refused');
    const titled = await candidates(f, { title: 'A different observation title' });
    assert.equal(await publish(f, { candidates: titled.token, approved: [] }, 'turn'), 'OBS-RESULT: failed links-refused');
    for (const [turn, change] of [['turn-b', { spaceKey: 'OTHER' }], ['turn-c', { searchedAt: new Date(Date.now() - 2 * 3600_000 - 1000).toISOString() }]] as const) {
        const { token } = await candidates(f, { turnId: turn });
        const file = path.join(f.dir, `${token}.json`);
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change }));
        assert.equal(await publish(f, { candidates: token, approved: [] }, turn), 'OBS-RESULT: failed links-refused', turn);
    }
    assert.deepEqual(f.writes(), []);
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
