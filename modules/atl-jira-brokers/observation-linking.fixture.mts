// Issue #736 fixture for the Codex adapter linking tests: a synthetic space, the
// measured search ranking and the publish helpers. Test-only; no production import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observationBroker } from './observation-broker.mts';
import { publishObservations } from './observation-publisher.mts';
import { receiptStore } from './observation-receipt.mts';
import type { ConfluenceContext } from './confluence-session.mts';

export const W = 'Synthetic logon task workaround for the agent account state';
export const PAGES = [
    { id: '41', title: 'Owner probe retry when the account lookup fails' },
    { id: '42', title: 'Codex session idle state after a switch' },
    { id: '51', title: 'Scheduled task does not start at logon' },
    { id: '52', title: 'Task trigger delay after logon' },
    { id: '53', title: 'Run a hook as the interactive user' },
    { id: '54', title: 'Session 0 isolation blocks the tray app' },
];
export const RANKING = ['51', '52', '53', '54', '41'];
export const TOPIC = 'A logon-triggered scheduled task never starts under the service account; running it as the interactive user fixes it.';
export const R1 = 'Same logon-trigger task that never starts; this page has the root cause.';
export const R2 = 'Documents the trigger delay the workaround has to tolerate at logon.';

export function fixture(t: { after(fn: () => void): void }, options: { searchFails?: boolean } = {}) {
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
export type Fixture = ReturnType<typeof fixture>;

export const finding = (links: unknown) => ({ title: W, bodyStorage: '<p>Origin: measured synthetic logon test</p>', evidence: 'assumed',
    labels: ['type-observation', 'evidence-assumed', 'status-author-model'], placement: { project: 'Kherep', app: '-' }, links });
export const publish = (f: Fixture, links: unknown, turnId = 'turn') =>
    publishObservations({ sessionId: 'synthetic', turnId, observations: [finding(links)] }, f.broker, f.store);
export async function candidates(f: Fixture, overrides: Record<string, string> = {}) {
    const out = await f.broker.candidates({ sessionId: 'synthetic', turnId: 'turn', title: W, topic: TOPIC, ...overrides });
    return { out, token: /^OBS-CANDIDATES: ok ([a-f0-9]{64}) \d+/.exec(out.text)?.[1] ?? '' };
}
