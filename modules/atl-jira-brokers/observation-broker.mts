/** Narrow publisher adapter. The only credential binding is the Codex broker's. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSession, currentUser, type ConfluenceContext } from './confluence-session.mts';
import { createPage, findSpace, getPage, listChildren, listLabels } from './confluence-content.mts';
import { ensureRuntimeLabel } from './confluence-label-cli.mts';
import { runtimeLabel } from './confluence-runtime-label.mts';
import { requireResolvableAnchors } from './confluence-related.mts';
import { semanticProposals } from './confluence-semantic.mts';
import { SCOPES, v2, type ConfluenceSession } from './confluence-contract.mts';
import type { ObservationBroker, Authority } from './observation-publisher.mts';
import { ObservationLookupError } from './observation-lookup.mts';
import { pageId } from './observation-policy.mts';
import { observationLinking } from './observation-linking.mts';
const CREDENTIAL = 'KHEREP_ATL_CRED_FILE_CODEX';
// A broken collection must not become an empty successful search or child list.
export function checkedSession(session: ConfluenceSession): ConfluenceSession {
    return { async request(spec) {
            const response = await session.request(spec);
            if (spec.method === 'GET' && /\/(?:pages|labels|children)(?:\?|$)|\/search\?/.test(spec.path)) {
                const json = response.json as {
                    results?: unknown;
                    _links?: {
                        next?: unknown;
                    };
                } | null;
                if (!Array.isArray(json?.results) || json.results.some(row => !row || typeof row !== 'object'))
                    throw new Error('collection-unavailable');
                const next = json._links?.next;
                if (next !== undefined && (typeof next !== 'string' || (next && !/^\/(?:wiki\/)?api\//.test(next))))
                    throw new Error('collection-unavailable');
            }
            if (spec.method === 'GET' && /^\/wiki\/api\/v2\/spaces\?/.test(spec.path)) {
                const json = response.json as { results?: unknown; _links?: { next?: unknown } } | null;
                const wanted = new URLSearchParams(spec.path.split('?')[1]).get('keys');
                if (!Array.isArray(json?.results) || json.results.length > 1 || json.results.some(row =>
                    !row || typeof row !== 'object' || Array.isArray(row) || !pageId(row.id)
                    || typeof row.key !== 'string' || !/^[A-Za-z0-9_~]+$/.test(row.key)
                    || row.key.toUpperCase() !== wanted?.toUpperCase() || typeof row.name !== 'string' || !row.name.trim())
                    || (json._links !== undefined && (!json._links || typeof json._links !== 'object' || Array.isArray(json._links)))
                    || (json._links?.next !== undefined && json._links.next !== ''))
                    throw new Error('collection-unavailable');
            }
            return response;
        } };
}
export function observationBroker(home: string, context?: ConfluenceContext, options: {
    semantic?: typeof semanticProposals;
} = {}): ObservationBroker & { candidates(input: unknown): Promise<{ text: string; isError: boolean }> } {
    const ctx = context ?? { env: process.env, credEnv: CREDENTIAL, readFile: fs.readFile, fetch: boundedFetch, now: Date.now, session: {} };
    if (ctx.credEnv !== CREDENTIAL)
        throw new Error('broker-unavailable');
    const session = checkedSession(createSession(ctx));
    let authorityText = '';
    const assertAuthorityUnchanged = async () => {
        if (await fs.readFile(path.join(home, 'kherep', 'confluence.json'), 'utf8') !== authorityText)
            throw new Error('authority-unavailable');
    };
    const linking = observationLinking({ session, home, semantic: options.semantic ?? semanticProposals, env: ctx.env,
        authority: async () => JSON.parse(await fs.readFile(path.join(home, 'kherep', 'confluence.json'), 'utf8')) as Authority,
        assertAuthorityUnchanged });
    return {
        runtimeLabel: runtimeLabel(CREDENTIAL, ctx.env),
        async authority() {
            authorityText = await fs.readFile(path.join(home, 'kherep', 'confluence.json'), 'utf8');
            if (authorityText.length > 32000)
                throw new Error('authority-unavailable');
            return JSON.parse(authorityText) as Authority;
        },
        async space(key) {
            if (!ctx.env.KHEREP_ATL_SITE?.trim() || !ctx.env[CREDENTIAL]?.trim())
                throw new ObservationLookupError('space-lookup-bindings-missing');
            return findSpace(session, key);
        },
        identity: async () => (await currentUser(session))?.accountId ?? null,
        async parent(spaceId, nodeId, app) {
            const shelf = await getPage(session, nodeId);
            if (shelf.id !== nodeId || shelf.spaceId !== spaceId || shelf.status !== 'current')
                throw new Error('placement-unresolved');
            if (!app)
                return nodeId;
            const hits = (await listChildren(session, nodeId)).filter(child => child.title === app);
            if (hits.length !== 1 || !pageId(hits[0].id))
                throw new Error('placement-unresolved');
            const child = await getPage(session, hits[0].id);
            const { json } = await session.request({ method: 'GET', path: v2(`/pages/${child.id}`), scope: SCOPES.get });
            if (child.spaceId !== spaceId || child.status !== 'current' || (json as {
                parentId?: unknown;
            })?.parentId !== nodeId)
                throw new Error('placement-unresolved');
            return child.id;
        },
        candidates: linking.candidates,
        links: linking.links,
        related: async (_spaceId, key, finding, _parent, linked) => linking.related(key, finding, linked),
        async create(spaceId, finding, parent, body) {
            await assertAuthorityUnchanged();
            await requireResolvableAnchors(session, body, spaceId);
            return (await createPage(session, { spaceId, title: finding.title, parentId: parent, representation: 'storage', value: body })).id;
        },
        async labels(id, labels) { await assertAuthorityUnchanged(); await ensureRuntimeLabel(session, id, labels, CREDENTIAL, ctx.env); },
        async read(id) {
            const { json } = await session.request({ method: 'GET', path: v2(`/pages/${id}?body-format=storage`), scope: SCOPES.get });
            const raw = json as {
                id: string;
                title: string;
                spaceId: string;
                parentId: string;
                authorId: string;
                body?: {
                    storage?: {
                        value?: string;
                    };
                };
            };
            return { id: raw.id, title: raw.title, spaceId: raw.spaceId, parentId: raw.parentId, authorId: raw.authorId,
                body: raw.body?.storage?.value ?? '', labels: await listLabels(session, id) };
        },
        stitch: linking.stitch,
    };
}
// Bound provider bodies and timeouts without returning raw provider failures.
const boundedFetch: ConfluenceContext['fetch'] = async (url, options) => {
    const signal = AbortSignal.timeout(30000);
    let response: Response;
    try { response = await fetch(url, { ...options, redirect: 'error', signal }); }
    catch (error) {
        if (signal.aborted) throw new ObservationLookupError('space-lookup-timeout');
        throw error;
    }
    let text: string | undefined;
    const read = async () => {
        if (text !== undefined)
            return text;
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader)
            while (true) {
                const part = await reader.read().catch(error => {
                    if (signal.aborted) throw new ObservationLookupError('space-lookup-timeout');
                    throw error;
                });
                if (part.done)
                    break;
                size += part.value.length;
                if (size > 4 * 1024 * 1024) {
                    await reader.cancel();
                    throw new Error('broker-unavailable');
                }
                chunks.push(part.value);
            }
        const body = Buffer.concat(chunks).toString('utf8');
        // Link metadata cannot prove absence. A positive row still passes the
        // narrow session's key/shape/continuation and publisher's identity checks.
        if (/^\/ex\/confluence\/[^/]+\/wiki\/api\/v2\/spaces$/.test(new URL(url).pathname) && response.headers.get('link')?.trim()) {
            const json = JSON.parse(body) as { results?: unknown } | null;
            if (!Array.isArray(json?.results) || json.results.length !== 1)
                throw new Error('collection-unavailable');
        }
        text = body;
        return text;
    };
    return { status: response.status, ok: response.ok, text: read, json: async () => JSON.parse(await read()) };
};
