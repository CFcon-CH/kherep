import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { observationRpc } from './observation-stdio.mts';
import { observationBroker } from './observation-broker.mts';
import { publishObservations } from './observation-publisher.mts';
import { receiptStore, receiptKey } from './observation-receipt.mts';
import type { ConfluenceContext } from './confluence-session.mts';
const finding = { title: 'Synthetic journal transport', bodyStorage: '<p>Origin: measured test -> passed</p>', evidence: 'assumed',
    labels: ['type-observation', 'evidence-assumed', 'status-author-model'], placement: { project: 'Kherep', app: '-' },
    links: { candidates: 'a'.repeat(64), approved: [] as { id: string; reason: string }[] } };
const request = () => ({ sessionId: 'synthetic', turnId: 'turn', observations: [structuredClone(finding)] });
const TOPIC = 'The synthetic journal transport replays a receipt without I/O.';
const REASON = 'Same journal transport; this page is its measured baseline.';
type Fixture = ReturnType<typeof fixture>;
// Issue #736: the candidates call before publication. Each finding gets the
// token of its own receipt and, when asked, the approved ids with a reason.
async function linked(f: Fixture, r = request(), approve: string[] = []) {
    for (const o of r.observations) {
        const out = await f.broker.candidates({ sessionId: r.sessionId, turnId: r.turnId, title: o.title, topic: TOPIC });
        const token = /^OBS-CANDIDATES: ok ([a-f0-9]{64}) /.exec(out.text)?.[1];
        if (!token) throw new Error(out.text);
        o.links = { candidates: token, approved: approve.map(id => ({ id, reason: REASON })) };
    }
    return r;
}
function fixture(t: {
    after(fn: () => void): void;
}, options: { serialize?: (body: string, method: 'POST' | 'PUT') => string; peerTitle?: string; peerBody?: string;
    // Further pages of the space and the search ranking over them (issue #736 replay).
    pages?: { id: string; title: string }[]; ranking?: string[] } = {}) {
    const others = new Map((options.pages ?? []).map(p => [p.id, { ...p, spaceId: '10', parentId: '20', status: 'current', version: { number: 1 },
        body: { storage: { value: `<p>${p.title}</p>` } } }]));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-adapter-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'kherep'));
    fs.writeFileSync(path.join(home, 'kherep', 'confluence.json'), JSON.stringify({
        observationPublishingAuthorized: true, spaceKey: 'SYNTHETIC', spaceId: '10', nodes: { Kherep: '20', 'Development/Forge Apps': '20' }
    }));
    const calls: {
        method: string;
        route: string;
        body?: any;
    }[] = [];
    const labels: string[] = [];
    let page: any;
    let peer: any = { id: '30', title: options.peerTitle ?? 'Synthetic journal transport baseline', spaceId: '10', parentId: '20', status: 'current', version: { number: 1 }, body: { storage: { value: options.peerBody ?? '<p>Synthetic peer</p>' } } };
    let mode = '';
    let peerReads = 0;
    const context: ConfluenceContext = { env: { KHEREP_ATL_SITE: 'https://synthetic.invalid', KHEREP_ATL_CRED_FILE_CODEX: '/synthetic-credential', KHEREP_PROFILE: 'mac' },
        credEnv: 'KHEREP_ATL_CRED_FILE_CODEX', readFile: async () => 'client_id: synthetic\nclient_secret: CANARY_SECRET', now: Date.now, session: {},
        fetch: async (url, opts) => {
            const route = url.replace(/^https:\/\/api\.atlassian\.com\/ex\/confluence\/synthetic-cloud(?=\/|$)/, '');
            const method = opts?.method ?? 'GET';
            const body = opts?.body ? JSON.parse(opts.body.toString()) : undefined;
            calls.push({ method, route, body });
            let json: any = {};
            let status = 200;
            if (url === 'https://auth.atlassian.com/oauth/token')
                json = { access_token: 'CANARY_TOKEN', expires_in: 3600 };
            else if (url.endsWith('/_edge/tenant_info'))
                json = { cloudId: 'synthetic-cloud' };
            else if (route === '/wiki/rest/api/user/current')
                json = mode === 'missing-author' ? {} : { accountId: 'synthetic-service' };
            else if (route.startsWith('/wiki/api/v2/spaces?'))
                json = { results: [{ id: '10', key: 'SYNTHETIC', name: 'Synthetic' }] };
            else if (route.startsWith('/wiki/api/v2/spaces/10/pages?'))
                json = { results: [{ id: '20', title: 'Kherep' }, ...(mode.startsWith('stitch') ? [peer] : []), ...others.values(), ...(page ? [page] : [])] };
            else if (route.startsWith('/wiki/rest/api/search?')) {
                json = mode === 'partial-related' ? { results: [{}] } : { results: [] };
                if (mode === 'related-http') {
                    status = 503;
                    json = { message: 'CANARY_PROVIDER' };
                }
            }
            else if (route === '/wiki/api/v2/pages' && method === 'POST') {
                // Model Confluence's stored text nodes, independently of the broker serializer.
                let stored = body.body.value.split(/(<[^>]*>)/).map((part: string, index: number) => index % 2 ? part : part.replaceAll('>', '&gt;').replaceAll('"', '&quot;')).join('');
                stored = options.serialize?.(stored, 'POST') ?? stored;
                if (mode === 'stitch-corrupt-text') stored = stored.replace('measured', 'changed');
                if (mode === 'stitch-corrupt-backslash') stored = stored.replace('\\synthetic', '\\\\synthetic');
                if (mode === 'stitch-corrupt-tag') stored = stored.replace('<code>', '<pre>');
                if (mode === 'stitch-corrupt-link') stored = stored.replace('/pages/30"', '/pages/31"');
                page = { id: '100', status: 'current', title: body.title, parentId: body.parentId, spaceId: body.spaceId,
                    authorId: mode === 'wrong-author' ? 'foreign' : 'synthetic-service', version: { number: 1 }, body: { storage: { value: stored } } };
                json = page;
            }
            else if (route === '/wiki/api/v2/pages/20')
                json = { id: '20', spaceId: '10', title: 'Kherep', status: 'current' };
            else if (route === '/wiki/api/v2/pages/20/children?limit=250')
                json = { results: [{ id: '21', title: 'SyntheticApp' }] };
            else if (route === '/wiki/api/v2/pages/21')
                json = { id: '21', spaceId: '10', title: 'SyntheticApp', status: 'current', parentId: '999' };
            else if (route === '/wiki/api/v2/pages/30' && method === 'PUT') {
                peer = { ...peer, version: body.version, body: { storage: { value: mode === 'stitch-missing-link' ? '<p>missing link</p>' : options.serialize?.(body.body.value, 'PUT') ?? body.body.value } } };
                json = peer;
            }
            else if (route.startsWith('/wiki/api/v2/pages/30')) {
                if (route.includes('body-format=storage') && ++peerReads === 2 && mode === 'stitch-race')
                    peer = { ...peer, version: { number: 2 }, body: { storage: { value: '<p>HUMAN_EDIT</p>' + peer.body.storage.value } } };
                json = peer;
            }
            else if (/^\/wiki\/api\/v2\/pages\/\d+$/.test(route) && method === 'PUT' && others.has(route.split('/').pop()!)) {
                const id = route.split('/').pop()!;
                others.set(id, { ...others.get(id)!, version: body.version, body: { storage: { value: body.body.value } } });
                json = others.get(id);
            }
            else if (others.has(/^\/wiki\/api\/v2\/pages\/(\d+)/.exec(route)?.[1] ?? ''))
                json = others.get(/^\/wiki\/api\/v2\/pages\/(\d+)/.exec(route)![1]);
            else if (route.startsWith('/wiki/api/v2/pages/100/labels?'))
                json = { results: labels.map(name => ({ name })) };
            else if (route === '/wiki/rest/api/content/100/label' && method === 'POST') {
                labels.push(...body.map((v: any) => v.name));
                json = { results: labels.map(name => ({ name })) };
            }
            else if (route.startsWith('/wiki/api/v2/pages/100'))
                json = page;
            else
                throw new Error(`Unexpected synthetic route: ${method} ${route}`);
            return { status, ok: status === 200, json: async () => json, text: async () => JSON.stringify(json) };
        } };
    const semantic = async () => {
        if (mode === 'semantic-error') return { titles: [], error: 'CANARY_PROVIDER' };
        const ranked = (options.ranking ?? []).map(id => ({ id, title: others.get(id)!.title, snippet: `<p>${others.get(id)!.title} snippet</p>` }));
        const items = [...(mode.startsWith('stitch') ? [{ id: '30', title: peer.title, snippet: 'Synthetic peer' }] : []), ...ranked];
        return { titles: items.map(item => item.title), items };
    };
    const broker = observationBroker(home, context, { semantic });
    return { home, calls, broker, context, others, store: receiptStore(path.join(home, 'receipts')), mode: (value: string) => { mode = value; } };
}
test('synthetic transport refuses lookalike Atlassian hostname', async (t) => {
    const f = fixture(t);
    await assert.rejects(() => f.context.fetch('https://apiXatlassian.com/ex/confluence/synthetic-cloud/wiki/rest/api/user/current'), /Unexpected synthetic route/);
});
test('actual broker publishes with mandatory successful-empty related section, runtime labels and author verification', async (t) => {
    const f = fixture(t);
    assert.equal(await publishObservations(await linked(f), f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    const create = f.calls.find(c => c.method === 'POST' && c.route === '/wiki/api/v2/pages')!;
    assert.match(create.body.body.value, /No related page on this topic \(0 candidates reviewed\)\./);
    assert.match(create.body.body.value, /Publication: .*session synthetic; turn turn; runtime-codex-mac/);
    assert.ok(f.calls.some(c => c.route === '/wiki/rest/api/content/100/label'));
    const local = fs.readdirSync(path.join(f.home, 'receipts')).map(n => fs.readFileSync(path.join(f.home, 'receipts', n), 'utf8')).join();
    assert.doesNotMatch(local, /CANARY/);
});
for (const mode of ['success', 'denial', 'partial']) test(`RPC preserves real publisher ${mode} and terminal zero-I/O replay`, async t => {
    const f = fixture(t);
    if (mode === 'partial') f.mode('stitch-missing-link');
    const r = mode === 'denial' ? request() : await linked(f, request(), mode === 'partial' ? ['30'] : []);
    if (mode === 'denial') {
        const file = path.join(f.home, 'kherep', 'confluence.json');
        const authority = JSON.parse(fs.readFileSync(file, 'utf8'));
        authority.observationPublishingAuthorized = false;
        fs.writeFileSync(file, JSON.stringify(authority));
    }
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish_observations', arguments: r } };
    const publish = (args: unknown) => publishObservations(args, f.broker, f.store);
    const result = await observationRpc(call, publish) as any;
    const expected = mode === 'success' ? 'OBS-RESULT: wrote 1 100' : mode === 'denial'
        ? 'OBS-RESULT: failed authority-denied' : 'OBS-RESULT: failed stitch-unverified created=100';
    assert.equal(result.result.content[0].text, expected);
    assert.equal(result.result.isError, mode !== 'success');
    const count = f.calls.length;
    assert.deepEqual(await observationRpc(call, publish), result);
    assert.equal(f.calls.length, count);
    assert.equal(f.calls.filter(c => c.method === 'POST' && c.route === '/wiki/api/v2/pages').length, mode === 'denial' ? 0 : 1);
});
test('RPC empty publication performs zero broker and journal I/O', async t => {
    const f = fixture(t);
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish_observations', arguments: { ...request(), observations: [] } } };
    const response = await observationRpc(call, args => publishObservations(args, f.broker, { claim() { throw new Error('unexpected journal I/O'); } })) as any;
    assert.equal(response.result.content[0].text, 'OBS-RESULT: empty no-admissible-findings');
    assert.equal(response.result.isError, false);
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(path.join(f.home, 'receipts')), false);
});
for (const mode of ['missing-author', 'wrong-author', 'partial-related', 'related-http', 'semantic-error'])
    test(`actual broker fails safely for ${mode}`, async (t) => {
        const f = fixture(t);
        const searchFails = mode !== 'missing-author' && mode !== 'wrong-author';
        const r = searchFails ? request() : await linked(f);
        f.mode(mode);
        if (searchFails) {
            // A failed candidate search is UNKNOWN: no receipt, so the publish is refused.
            const out = await f.broker.candidates({ sessionId: 'synthetic', turnId: 'turn', title: finding.title, topic: TOPIC });
            assert.deepEqual(out, { text: 'OBS-CANDIDATES: failed related-unavailable', isError: true });
            assert.equal(fs.existsSync(path.join(f.home, '.cache', 'observation-publisher', 'candidates')), false);
        }
        const result = await publishObservations(r, f.broker, f.store);
        if (searchFails) assert.equal(result, 'OBS-RESULT: failed links-refused');
        assert.match(result, /^OBS-RESULT: failed /);
        assert.doesNotMatch(result, /CANARY/);
        assert.equal(f.calls.filter(c => c.method === 'POST' && c.route === '/wiki/api/v2/pages').length, mode === 'wrong-author' ? 1 : 0);
    });
test('a listed app that moved to another parent is refused', async (t) => {
    const f = fixture(t);
    const r = await linked(f);
    r.observations[0].placement = { project: 'Development/Forge Apps', app: 'SyntheticApp' };
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed placement-unresolved');
});
test('corrupted receipt and symlink receipt never echo a canary', async (t) => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.home, 'receipts'));
    const file = path.join(f.home, 'receipts', `${receiptKey('synthetic', 'turn')}.json`);
    fs.writeFileSync(file, JSON.stringify({ digest: 'a'.repeat(64), ids: [], result: 'CANARY_SECRET' }));
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed receipt-unavailable');
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(f.home, 'kherep', 'confluence.json'), file);
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed receipt-unavailable');
    assert.equal(f.calls.length, 0);
});
test('stdio exposes exactly two tools and invalid mutating messages cause zero publication calls', async () => {
    let calls = 0;
    const publish = async () => { calls++; return 'OBS-RESULT: empty no-admissible-findings'; };
    const list = await observationRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, publish) as any;
    assert.deepEqual(list.result.tools.map((tool: any) => tool.name), ['publish_observations', 'related_candidates']);
    assert.equal(list.result.tools[1].annotations.readOnlyHint, true);
    for (const payload of [{ jsonrpc: '2.0', method: 'tools/call', params: { name: 'publish_observations', arguments: {} } },
        { jsonrpc: '2.0', id: { bad: 'id' }, method: 'tools/call', params: { name: 'publish_observations', arguments: {} } },
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish_observations' } },
        { jsonrpc: '2.0', id: 1, method: 'notifications/cancelled', params: {} },
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec', arguments: {} } }])
        await observationRpc(payload, publish);
    assert.equal(calls, 0);
});
test('real stdio empty findings succeed without configuration, credentials or valid profile', t => {
    const f = fixture(t);
    const home = path.join(f.home, 'absent-home');
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'observation-stdio.mts')], { encoding: 'utf8', env: { PATH: process.env.PATH, CODEX_HOME: home, KHEREP_PROFILE: 'unconfigured' },
        input: [undefined, { progressToken: 1, threadId: 'METADATA_CANARY' }].map((_meta, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name: 'publish_observations', arguments: { ...request(), observations: [] }, ...(_meta ? { _meta } : {}) } })).join('\n') + '\n' });
    assert.equal(run.status, 0, run.stderr);
    const responses = run.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(responses.length, 2);
    assert.ok(responses.every(response => response.result.content[0].text === 'OBS-RESULT: empty no-admissible-findings'));
    assert.doesNotMatch(run.stdout, /METADATA_CANARY/);
    assert.equal(fs.existsSync(home), false);
});
test('targeted stitching adds and independently verifies the new page link on its related neighbour', async (t) => {
    const f = fixture(t);
    f.mode('stitch-ok');
    assert.equal(await publishObservations(await linked(f, request(), ['30']), f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    const writes = f.calls.filter(call => call.method === 'PUT');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].route, '/wiki/api/v2/pages/30');
    assert.match(writes[0].body.body.value, /pages\/100/);
    assert.equal(writes[0].body.version.message, `observation link: ${REASON}`);
    assert.ok(f.calls.some(call => call.method === 'GET' && call.route === '/wiki/api/v2/pages/30?body-format=storage'));
});
// Issue #730: model storage serialization after the actual POST or guarded PUT,
// not a replacement broker/update callback. The stored page also serves GETs.
for (const phase of ['POST', 'PUT'] as const) for (const transform of ['paragraph', 'apostrophe'])
    test(`exact production readback survives ${phase} ${transform} storage serialization`, async t => {
        const f = fixture(t, {
            peerTitle: "Synthetic journal transport isn't duplicated",
            // A legacy Related block and ordinary link must both survive the merge.
            peerBody: '<p>Synthetic peer <a href="/wiki/spaces/SYNTHETIC/pages/20">shelf</a></p><h2>Related pages</h2><ul><li><a href="/wiki/spaces/SYNTHETIC/pages/20">Kherep</a></li></ul>',
            serialize: (body, method) => method !== phase ? body : transform === 'paragraph'
                ? body.replace(/<li>(<a\b[^>]*>.*?<\/a>)<\/li>/g, '<li><p>$1</p></li>')
                : body.replaceAll('&#39;', "'"),
        });
        f.mode('stitch-ok');
        const r = request();
        r.observations[0].title = "Synthetic journal transport isn't repeated";
        await linked(f, r, ['30']);
        const result = await publishObservations(r, f.broker, f.store);
        const count = f.calls.length;
        assert.equal(await publishObservations(r, f.broker, f.store), result);
        assert.equal(f.calls.length, count, 'terminal receipt replay must perform zero I/O');
        assert.equal(result, 'OBS-RESULT: wrote 1 100');
        const create = f.calls.find(c => c.method === 'POST' && c.route === '/wiki/api/v2/pages')!;
        const writes = f.calls.filter(c => c.method === 'PUT');
        assert.equal(writes.length, 1);
        assert.equal(writes[0].route, '/wiki/api/v2/pages/30');
        const peer = await (await f.context.fetch('https://api.atlassian.com/ex/confluence/synthetic-cloud/wiki/api/v2/pages/30?body-format=storage')).json() as any;
        assert.equal((await f.broker.read('100')).body, create.body.body.value);
        assert.equal(peer.body.storage.value, writes[0].body.body.value);
        assert.match(peer.body.storage.value, /^<p>Synthetic peer <a href="\/wiki\/spaces\/SYNTHETIC\/pages\/20">shelf<\/a><\/p>/);
        assert.match(peer.body.storage.value, /<li><p><a href="\/wiki\/spaces\/SYNTHETIC\/pages\/20">Kherep<\/a><\/p><\/li>/);
        assert.match(peer.body.storage.value, /pages\/100/);
    });
for (const corruption of ['text', 'tag', 'link', 'version', 'space', 'title', 'status'])
    test(`guarded stitch rejects changed ${corruption} and replays the created ID without I/O`, async t => {
        const f = fixture(t);
        f.mode('stitch-ok');
        const transport = f.context.fetch;
        f.context.fetch = async (url, opts) => {
            const response = await transport(url, opts);
            const data = await response.json() as any;
            if (url.endsWith('/wiki/api/v2/pages/30') && opts?.method === 'PUT') {
                if (corruption === 'text') data.body.storage.value = data.body.storage.value.replace('Synthetic peer', 'Changed peer');
                if (corruption === 'tag') data.body.storage.value = data.body.storage.value.replace('<ul>', '<ol>');
                if (corruption === 'link') data.body.storage.value = data.body.storage.value.replace('/pages/100"', '/pages/20"');
                if (corruption === 'version') data.version.number++;
                if (corruption === 'space') data.spaceId = '999';
                if (corruption === 'title') data.title = 'Changed title';
                if (corruption === 'status') data.status = 'draft';
            }
            return { ...response, json: async () => data, text: async () => JSON.stringify(data) };
        };
        const r = await linked(f, request(), ['30']), expected = 'OBS-RESULT: failed stitch-unverified created=100';
        assert.equal(await publishObservations(r, f.broker, f.store), expected);
        const count = f.calls.length;
        assert.equal(await publishObservations(r, f.broker, f.store), expected);
        assert.equal(f.calls.length, count);
        assert.equal(f.calls.filter(c => c.method === 'POST' && c.route === '/wiki/api/v2/pages').length, 1);
        assert.deepEqual(f.calls.filter(c => c.method === 'PUT').map(c => c.route), ['/wiki/api/v2/pages/30']);
    });
test('a stitch write whose link cannot be read back fails with the created ID', async (t) => {
    const f = fixture(t);
    f.mode('stitch-missing-link');
    assert.equal(await publishObservations(await linked(f, request(), ['30']), f.broker, f.store), 'OBS-RESULT: failed stitch-unverified created=100');
});
test('independent backlink read rejects a link lost after successful guarded readback', async t => {
    const f = fixture(t);
    f.mode('stitch-ok');
    const transport = f.context.fetch;
    let written = false, reads = 0;
    f.context.fetch = async (url, opts) => {
        const response = await transport(url, opts);
        if (opts?.method === 'PUT') written = true;
        if (written && url.endsWith('/pages/30?body-format=storage') && ++reads === 2) {
            const data = structuredClone(await response.json()) as any;
            data.body.storage.value = '<p>Backlink removed</p>';
            return { ...response, json: async () => data, text: async () => JSON.stringify(data) };
        }
        return response;
    };
    const r = await linked(f, request(), ['30']), expected = 'OBS-RESULT: failed stitch-unverified created=100';
    assert.equal(await publishObservations(r, f.broker, f.store), expected);
    assert.equal(reads, 2, 'guarded readback passed before the independent read failed');
    const count = f.calls.length;
    assert.equal(await publishObservations(r, f.broker, f.store), expected);
    assert.equal(f.calls.length, count);
});
test('stitch fresh-version merge preserves an intervening human body edit', async (t) => {
    const f = fixture(t);
    f.mode('stitch-race');
    assert.equal(await publishObservations(await linked(f, request(), ['30']), f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    const write = f.calls.find(call => call.method === 'PUT')!;
    assert.match(write.body.body.value, /HUMAN_EDIT/);
    assert.match(write.body.body.value, /pages\/100/);
    assert.equal(write.body.version.number, 3);
});
// Issue #710: the adapter stitches one verified page id and never reaches the sweep.
for (const id of ['', ' ', 'abc'])
    test(`targeted stitch refuses page id ${JSON.stringify(id)} before any request`, async (t) => {
        const f = fixture(t);
        const approved = [{ id: '30', reason: REASON, area: 'Kherep', title: 'Synthetic peer' }];
        await assert.rejects(() => f.broker.stitch(id, '10', 'SYNTHETIC', { approved, reviewed: 1 }), /^Error: stitch-unverified$/);
        assert.deepEqual(f.calls, []);
    });
test('native tools/call accepts _meta progressToken:number and threadId without forwarding metadata', async () => {
    const args = { ...request(), observations: [] };
    const received: unknown[] = [];
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: 'publish_observations', arguments: args,
            _meta: { progressToken: 7, threadId: 'METADATA_CANARY_NATIVE_THREAD' },
        } };
    const response = await observationRpc(call, async (value) => {
        received.push(value);
        return 'OBS-RESULT: empty no-admissible-findings';
    }) as any;
    assert.deepEqual(received, [args]);
    assert.equal(response.result.content[0].text, 'OBS-RESULT: empty no-admissible-findings');
    assert.doesNotMatch(JSON.stringify(response), /METADATA_CANARY|progressToken|threadId/);
});
test('bounded metadata extensions and string progress tokens are accepted without publication identity changes', async () => {
    const args = { ...request(), observations: [] };
    let calls = 0;
    for (const metadata of [{}, { progressToken: 'synthetic-progress' }, { threadId: { extension: true }, otherExtension: ['ignored'] }]) {
        await observationRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
                name: 'publish_observations', arguments: args, _meta: metadata,
            } }, async (value) => { calls++; assert.strictEqual(value, args); return 'OBS-RESULT: empty no-admissible-findings'; });
    }
    assert.equal(calls, 3);
});
test('malformed or oversized metadata and unknown control keys never invoke publication', async () => {
    let calls = 0;
    const publish = async () => { calls++; return 'OBS-RESULT: empty no-admissible-findings'; };
    const params = { name: 'publish_observations', arguments: { ...request(), observations: [] } };
    for (const metadata of [null, [], 'METADATA_CANARY', 7, { progressToken: null }, { progressToken: {} },
        { progressToken: true }, { progressToken: Number.POSITIVE_INFINITY }, { extension: 'x'.repeat(4096) }, { extension: 'é'.repeat(2050) }]) {
        const response = await observationRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { ...params, _meta: metadata } }, publish) as any;
        assert.equal(response.error.code, -32602);
        assert.doesNotMatch(JSON.stringify(response), /METADATA_CANARY|progressToken|threadId/);
    }
    const response = await observationRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            ...params, _meta: { progressToken: 1 }, spaceId: '999',
        } }, publish) as any;
    assert.equal(response.error.code, -32602);
    assert.equal(calls, 0);
});

for (const [body, expected] of [
    ['<p>Origin: measured command -> passed &amp; recorded</p>', '<p>Origin: measured command -&gt; passed &amp; recorded</p>'],
    ['<pre><code>Origin: measured command -&gt; passed &amp; recorded</code></pre>', '<pre><code>Origin: measured command -&gt; passed &amp; recorded</code></pre>'],
]) test(`Confluence prose greater-than encoding preserves exact readback: ${body.includes('->') ? 'literal arrow' : 'existing entity'}`, async t => {
    const f = fixture(t);
    const r = await linked(f);
    r.observations[0].bodyStorage = body;
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    const create = f.calls.find(call => call.method === 'POST' && call.route === '/wiki/api/v2/pages')!;
    assert.ok(create.body.body.value.startsWith(expected));
    assert.doesNotMatch(create.body.body.value, /&amp;gt;/);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.route === '/wiki/api/v2/pages').length, 1);
});

for (const [body, expected] of [
    ['<p>Origin: measured "synthetic" -> passed</p>', '<p>Origin: measured &quot;synthetic&quot; -&gt; passed</p>'],
    [String.raw`<pre><code>Origin: measured C:\synthetic\"quote\" -> 'passed' &amp; &lt; &gt; &quot; &#34; &#x22;</code></pre>`,
        String.raw`<pre><code>Origin: measured C:\synthetic\&quot;quote\&quot; -&gt; 'passed' &amp; &lt; &gt; &quot; &#34; &#x22;</code></pre>`],
]) test(`default broker POST and GET agree on prose quotes: ${body.startsWith('<p>') ? 'literal' : 'backslashes and entities'}`, async t => {
    const f = fixture(t), r = await linked(f);
    r.observations[0].bodyStorage = body;
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    const creates = f.calls.filter(call => call.method === 'POST' && call.route === '/wiki/api/v2/pages');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].body.body.value.slice(0, expected.length), expected);
    assert.equal((await f.broker.read('100')).body, creates[0].body.body.value);
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.route === '/wiki/api/v2/pages').length, 1);
});
test('caller tag attributes are rejected before broker or journal I/O', async t => {
    const f = fixture(t), r = request();
    r.observations[0].bodyStorage = String.raw`<p title="C:\synthetic > quote">Origin: measured "value"</p>`;
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed invalid-request');
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'receipts')), false);
});
for (const corruption of ['text', 'backslash', 'tag', 'link']) test(`exact readback rejects stored ${corruption} corruption without retry or stitching`, async t => {
    const f = fixture(t);
    f.mode(`stitch-corrupt-${corruption}`);
    const r = await linked(f, request(), ['30']);
    r.observations[0].bodyStorage = String.raw`<p>Origin: measured "value"</p><pre><code>C:\synthetic</code></pre>`;
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed readback-unverified created=100');
    const count = f.calls.length;
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed readback-unverified created=100');
    assert.equal(f.calls.length, count);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.route === '/wiki/api/v2/pages').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

// Independent transport model: only stored text spans change, never metadata or tags.
const curlyStorage = (body: string): string => body.split(/(<[^>]*>)/).map((part, index) => index % 2 ? part
    : part.replaceAll('\u2019', '&rsquo;').replaceAll('\u2018', '&lsquo;')).join('');
const creates = (f: Fixture) => f.calls.filter(call => call.method === 'POST' && call.route === '/wiki/api/v2/pages');
async function terminalReplay(f: Fixture, r: ReturnType<typeof request>, result: string) {
    const count = f.calls.length;
    assert.equal(await publishObservations(r, f.broker, f.store), result);
    assert.equal(f.calls.length, count, 'terminal replay performs zero transport I/O');
}
test('Unicode roundtrip prose POST preserves exact submitted and stored bytes', async t => {
    const f = fixture(t, { serialize: curlyStorage }), r = await linked(f);
    r.observations[0].bodyStorage = '<p>Origin: measured Node’s ‘input’</p>';
    const result = await publishObservations(r, f.broker, f.store);
    await terminalReplay(f, r, result);
    assert.equal(creates(f).length, 1); assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
    assert.equal(result, 'OBS-RESULT: wrote 1 100');
    assert.ok(creates(f)[0].body.body.value.startsWith('<p>Origin: measured Node&rsquo;s &lsquo;input&rsquo;</p>'));
    assert.equal((await f.broker.read('100')).body, creates(f)[0].body.body.value);
});
test('Unicode roundtrip forward anchor POST preserves plain title escaping', async t => {
    const f = fixture(t, { serialize: curlyStorage, peerTitle: "Synthetic journal transport Node’s ‘baseline’ &rsquo; & 'ASCII'" });
    f.mode('stitch-ok'); const r = await linked(f, request(), ['30']);
    const result = await publishObservations(r, f.broker, f.store); await terminalReplay(f, r, result);
    assert.equal(creates(f).length, 1); assert.equal(result, 'OBS-RESULT: wrote 1 100');
    assert.ok(creates(f)[0].body.body.value.includes("Node&rsquo;s &lsquo;baseline&rsquo; &amp;rsquo; &amp; 'ASCII'"));
    assert.equal((await f.broker.read('100')).body, creates(f)[0].body.body.value);
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
});
test('Unicode roundtrip backlink PUT preserves literal title metadata and exact guarded update', async t => {
    const prefix = '<p>Synthetic peer unchanged</p>';
    const f = fixture(t, { peerBody: prefix, serialize: (body, method) => method === 'PUT' ? curlyStorage(body) : body });
    f.mode('stitch-ok'); const r = request(); r.observations[0].title = 'Synthetic journal transport Node’s ‘input’';
    await linked(f, r, ['30']); const result = await publishObservations(r, f.broker, f.store); await terminalReplay(f, r, result);
    assert.equal(creates(f).length, 1); const writes = f.calls.filter(c => c.method === 'PUT'); assert.equal(writes.length, 1);
    assert.equal(result, 'OBS-RESULT: wrote 1 100');
    assert.equal(creates(f)[0].body.title, r.observations[0].title);
    assert.equal((await f.broker.read('100')).title, r.observations[0].title);
    const peer = await (await f.context.fetch('https://api.atlassian.com/ex/confluence/synthetic-cloud/wiki/api/v2/pages/30?body-format=storage')).json() as any;
    assert.equal(peer.body.storage.value, writes[0].body.body.value); assert.ok(peer.body.storage.value.startsWith(prefix));
    assert.ok(peer.body.storage.value.includes('Node&rsquo;s &lsquo;input&rsquo;')); assert.equal(writes[0].body.version.number, 2);
    assert.match(peer.body.storage.value, /<li><p><a href="\/wiki\/spaces\/SYNTHETIC\/pages\/100">/);
});
for (const [name, body, expected] of [
    ['right', '<p>Origin: measured Node’s input</p>', '<p>Origin: measured Node&rsquo;s input</p>'],
    ['left', '<p>Origin: measured ‘input</p>', '<p>Origin: measured &lsquo;input</p>'],
    ['pair', '<p>Origin: measured ‘input’</p>', '<p>Origin: measured &lsquo;input&rsquo;</p>'],
    ['code', '<pre><code>Origin: measured ‘input’</code></pre>', '<pre><code>Origin: measured &lsquo;input&rsquo;</code></pre>'],
    ['mixed', String.raw`<pre><code>Origin: measured Node’s ‘input’ 'ASCII' "quote" > C:\synthetic &amp; &rsquo; &lsquo; &amp;rsquo;</code></pre>`,
        String.raw`<pre><code>Origin: measured Node&rsquo;s &lsquo;input&rsquo; 'ASCII' &quot;quote&quot; &gt; C:\synthetic &amp; &rsquo; &lsquo; &amp;rsquo;</code></pre>`],
]) test(`Unicode text-span matrix ${name} preserves entities and backslashes`, async t => {
    const f = fixture(t, { serialize: curlyStorage }), r = await linked(f); r.observations[0].bodyStorage = body;
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    assert.ok(creates(f)[0].body.body.value.startsWith(expected));
    assert.equal((await f.broker.read('100')).body, creates(f)[0].body.body.value);
});
for (const corruption of ['numeric-entity', 'target-id', 'extra-runtime-label'])
    test(`Unicode exact readback rejects independent ${corruption} and retains terminal ID`, async t => {
        const f = fixture(t, { serialize: body => curlyStorage(body).replaceAll('&rsquo;', corruption === 'numeric-entity' ? '&#8217;' : '&rsquo;') });
        f.mode('stitch-ok'); const transport = f.context.fetch;
        f.context.fetch = async (url, opts) => {
            const response = await transport(url, opts), data = structuredClone(await response.json()) as any;
            if (corruption === 'target-id' && url.endsWith('/pages/100?body-format=storage')) data.id = '101';
            if (corruption === 'extra-runtime-label' && url.includes('/pages/100/labels?')) data.results.push({ name: 'runtime-codex-win' });
            return { ...response, json: async () => data, text: async () => JSON.stringify(data) };
        };
        const r = await linked(f, request(), ['30']); r.observations[0].bodyStorage = '<p>Origin: measured Node’s input</p>';
        const expected = 'OBS-RESULT: failed readback-unverified created=100';
        assert.equal(await publishObservations(r, f.broker, f.store), expected); await terminalReplay(f, r, expected);
        assert.equal(creates(f).length, 1); assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
    });
import { contentDigest } from './observation-receipt.mts';
import { observationRequest } from './observation-policy.mts';
test('Unicode correction never reopens a preexisting terminal readback-failure receipt', async t => {
    const f = fixture(t, { serialize: curlyStorage }), r = request(); r.observations[0].bodyStorage = '<p>Origin: measured Node’s ‘input’</p>';
    const held = f.store.claim(receiptKey(r.sessionId, r.turnId), contentDigest(observationRequest(r)));
    held.receipt.ids = ['100']; held.receipt.result = 'OBS-RESULT: failed readback-unverified created=100'; held.save(); held.release();
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed readback-unverified created=100');
    assert.deepEqual(f.calls, []);
});
