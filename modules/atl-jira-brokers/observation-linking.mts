/** Codex adapter linking (issue #736): candidates before create, approved links only. */
// The adapter never decides a link. `related_candidates` searches and stores a
// receipt; codex-obs judges each row on topic and names the approved ids with
// a reason inside the single publish request; only those ids are linked, in
// both directions. Shared title words are a printed hint, never a reason.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { candidateRow, checkRelatedLinks, parseReceipt, RECEIPT_MAX_AGE_MS, RELATED_RECEIPT_KIND, type RelatedReceipt } from './confluence-candidates.mts';
import { SCOPES, v2, type ConfluenceSession } from './confluence-contract.mts';
import { findSpace, getPage, updatePage } from './confluence-content.mts';
import { existingRelated, findRelated, relatedSection, withRelated, type NeighbourDeps } from './confluence-neighbours.mts';
import { outgoingIds, requireResolvableAnchors } from './confluence-related.mts';
import type { semanticProposals } from './confluence-semantic.mts';
import { DEFAULT_PER_PAGE, writeApproved, type Approved } from './confluence-stitch.mts';
import { pageId, safeId, type Finding } from './observation-policy.mts';
import type { Authority } from './observation-publisher.mts';

export interface Linked {
    approved: (Approved & { title: string })[];
    // How many candidates the receipt offered: the no-link sentence names it.
    reviewed: number;
}
export interface LinkingContext {
    session: ConfluenceSession;
    home: string;
    semantic: typeof semanticProposals;
    env: Record<string, string | undefined>;
    authority: () => Promise<Authority>;
    assertAuthorityUnchanged: () => Promise<void>;
    now?: () => number;
}
const TOKEN = /^[a-f0-9]{64}$/;
const candidatesDir = (home: string) => path.join(home, '.cache', 'observation-publisher', 'candidates');
const printable = (value: unknown, min: number, max: number): value is string => typeof value === 'string'
    && value.trim().length >= min && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);

// Receipts are working state, not a journal: anything older than the 2 h a
// receipt is valid for is removed on every call. A failed prune is harmless.
function prune(dir: string, now: number): void {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const file = path.join(dir, name);
        try {
            const stat = fs.lstatSync(file);
            if (stat.isFile() && now - stat.mtimeMs > RECEIPT_MAX_AGE_MS) fs.rmSync(file);
        }
        catch { /* best effort */ }
    }
}

export function observationLinking(ctx: LinkingContext) {
    const { session } = ctx;
    const now = ctx.now ?? Date.now;
    const semantic = (query: string, limit?: number, options?: { spaceKey?: string }) =>
        ctx.semantic(query, limit ?? 25, { env: ctx.env, spaceKey: options?.spaceKey });
    const deps = (spaceId: string, spaceKey: string, errors: string[], log: (line: string) => void, createdId?: string): NeighbourDeps => ({ session, spaceId, spaceKey, semantic,
        log, logError: (line: string) => errors.push(line), update: async (id: string, value: string, message: string) => {
            await ctx.assertAuthorityUnchanged();
            if (!createdId || !existingRelated(value).includes(createdId))
                throw new Error('stitch-unverified');
            // Bind content and version to the same fresh read. Merge only the
            // owned Related block; the stitch's earlier ordinary body is stale.
            const { json } = await session.request({ method: 'GET', path: v2(`/pages/${id}?body-format=storage`), scope: SCOPES.get });
            const current = json as { id?: string; spaceId?: string; status?: string; version?: { number?: number }; body?: { storage?: { value?: string } } };
            const storage = current.body?.storage?.value, version = current.version?.number;
            if (current.id !== id || current.spaceId !== spaceId || current.status !== 'current' || typeof storage !== 'string'
                || !Number.isSafeInteger(version) || !version || version < 1)
                throw new Error('stitch-unverified');
            const merged = [...new Set([...existingRelated(storage), createdId])].filter(target => target !== id);
            if (merged.length > 100)
                throw new Error('stitch-unverified');
            const pages = await Promise.all(merged.map(target => getPage(session, target)));
            if (pages.some(page => page.spaceId !== spaceId || page.status !== 'current'))
                throw new Error('stitch-unverified');
            const next = withRelated(storage, relatedSection(spaceKey, pages));
            await requireResolvableAnchors(session, next, spaceId);
            await updatePage(session, { id, value: next, representation: 'storage', message, expectedVersion: version });
        } });
    return {
        // The read-only `related_candidates` tool. It never touches the journal.
        async candidates(input: unknown): Promise<{ text: string; isError: boolean }> {
            const r = input as { sessionId?: unknown; turnId?: unknown; title?: unknown; topic?: unknown; placement?: unknown } | null;
            const keys = r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : null;
            const fold = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
            if (!keys || keys.some(key => !['sessionId', 'turnId', 'title', 'topic', 'placement'].includes(key))
                || !safeId(r!.sessionId) || !safeId(r!.turnId) || !printable(r!.title, 1, 200) || !printable(r!.topic, 10, 500)
                || fold(r!.title as string).includes(fold(r!.topic as string))
                || (r!.placement !== undefined && (!r!.placement || typeof r!.placement !== 'object' || Array.isArray(r!.placement))))
                return { text: 'OBS-CANDIDATES: failed invalid-request', isError: true };
            const failed = { text: 'OBS-CANDIDATES: failed related-unavailable', isError: true };
            try {
                const authority = await ctx.authority();
                if (authority.observationPublishingAuthorized !== true || typeof authority.spaceKey !== 'string' || !pageId(authority.spaceId))
                    return failed;
                const space = await findSpace(session, authority.spaceKey);
                if (!space || space.id !== authority.spaceId)
                    return failed;
                const errors: string[] = [];
                const found = await findRelated(deps(space.id, space.key, errors, () => {}), { title: r!.title as string, topic: r!.topic as string, limit: DEFAULT_PER_PAGE });
                // A half-run search is UNKNOWN: no receipt, so nothing can be linked from it.
                if (found.failed.length || errors.length)
                    return failed;
                const receipt: RelatedReceipt = { kind: RELATED_RECEIPT_KIND, source: { title: r!.title as string }, spaceKey: space.key,
                    sessionId: r!.sessionId as string, turnId: r!.turnId as string, query: found.query,
                    searchedAt: new Date(now()).toISOString(), candidates: found.candidates };
                const dir = candidatesDir(ctx.home);
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
                prune(dir, now());
                const token = randomBytes(32).toString('hex');
                fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify(receipt), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
                const rows = found.candidates.map(candidate => `candidate\t${candidateRow(candidate)}`);
                return { text: [`OBS-CANDIDATES: ok ${token} ${found.candidates.length}`, ...rows].join('\n'), isError: false };
            }
            catch {
                return failed;
            }
        },
        // The terminal `links-refused` check, run for every finding before any write.
        async links(spaceKey: string, turn: { sessionId: string; turnId: string }, finding: Finding): Promise<Linked> {
            const token = finding.links.candidates;
            let receipt = null;
            if (TOKEN.test(token)) {
                const file = path.join(candidatesDir(ctx.home), `${token}.json`);
                const stat = fs.lstatSync(file, { throwIfNoEntry: false });
                if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 512 * 1024)
                    receipt = parseReceipt(fs.readFileSync(file, 'utf8'));
            }
            const problems = checkRelatedLinks(receipt, finding.links.approved,
                { title: finding.title, spaceKey, sessionId: turn.sessionId, turnId: turn.turnId, now: now() });
            if (problems.length || !receipt)
                throw new Error('links-refused');
            const offered = new Map(receipt.candidates.map(candidate => [candidate.id, candidate]));
            return { reviewed: receipt.candidates.length, approved: finding.links.approved.map(({ id, reason }) => {
                    const { area, title } = offered.get(id)!;
                    return { id, reason, area, title };
                }) };
        },
        async related(key: string, finding: Finding, linked: Linked): Promise<string> {
            // Match modeled stored text before submission; preserve tags,
            // existing entities and backslashes. Related anchors are appended below.
            const escaped: Record<string, string> = { '>': '&gt;', '"': '&quot;', '\u2018': '&lsquo;', '\u2019': '&rsquo;' };
            const prose = finding.bodyStorage.replace(/(<[^>]*>)|[>"\u2018\u2019]/g, (match, tag: string | undefined) => tag ?? escaped[match]);
            return withRelated(prose, linked.approved.length ? relatedSection(key, linked.approved)
                : `<h2>Related pages</h2><p>No related page on this topic (${linked.reviewed} candidates reviewed).</p>`);
        },
        async stitch(id: string, spaceId: string, key: string, linked: Linked): Promise<void> {
            // Issue #710: this adapter stitches one page and nothing else.
            if (!pageId(id))
                throw new Error('stitch-unverified');
            if (!linked.approved.length)
                return;
            const errors: string[] = [];
            const links: { from: string; to: string }[] = [];
            const result = await writeApproved(deps(spaceId, key, errors, line => {
                if (line.startsWith('link\t')) {
                    const [, from, to] = line.split('\t');
                    if (!pageId(from) || to !== id)
                        throw new Error();
                    links.push({ from, to });
                }
            }, id), id, linked.approved, decision => `observation link: ${decision.reason}`);
            if (result !== 0 || errors.length || links.length !== linked.approved.length)
                throw new Error('stitch-unverified');
            // The independent backlink read: the write's own report is not the measurement.
            for (const link of links) {
                const page = await getPage(session, link.from);
                const { json } = await session.request({ method: 'GET', path: v2(`/pages/${link.from}?body-format=storage`), scope: SCOPES.get });
                const body = (json as { body?: { storage?: { value?: unknown } } })?.body?.storage?.value;
                if (page.spaceId !== spaceId || typeof body !== 'string' || !outgoingIds(body).includes(id))
                    throw new Error('stitch-unverified');
            }
        },
    };
}
