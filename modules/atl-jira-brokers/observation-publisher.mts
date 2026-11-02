import { lookupFailure } from './observation-lookup.mts';
import { observationRequest, failed, pageId, type Finding } from './observation-policy.mts';
import { contentDigest, receiptKey, type ReceiptStore } from './observation-receipt.mts';
import type { Linked } from './observation-linking.mts';
export interface Authority {
    observationPublishingAuthorized?: unknown;
    spaceKey?: unknown;
    spaceId?: unknown;
    nodes?: Record<string, unknown>;
}
export interface Target {
    id: string;
    title: string;
    spaceId: string;
    parentId: string;
    body: string;
    labels: string[];
    authorId: string;
}
export interface ObservationBroker {
    authority(): Promise<Authority>;
    space(key: string): Promise<{
        id: string;
        key: string;
    } | null>;
    identity(): Promise<string | null>;
    parent(spaceId: string, nodeId: string, app: string): Promise<string>;
    // Issue #736: the approved links, checked against the candidates receipt
    // before any write. Throws links-refused; nothing is written then.
    links(spaceKey: string, turn: { sessionId: string; turnId: string }, finding: Finding): Promise<Linked>;
    related(spaceId: string, key: string, finding: Finding, parent: string, linked: Linked): Promise<string>;
    create(spaceId: string, finding: Finding, parent: string, body: string): Promise<string>;
    labels(id: string, labels: string[]): Promise<void>;
    read(id: string): Promise<Target>;
    stitch(id: string, spaceId: string, key: string, linked: Linked): Promise<void>;
    runtimeLabel: string;
}
export async function publishObservations(input: unknown, broker: ObservationBroker, store: ReceiptStore): Promise<string> {
    const request = observationRequest(input);
    if (!request)
        return failed('invalid-request');
    if (!request.observations.length)
        return 'OBS-RESULT: empty no-admissible-findings';
    let held: ReturnType<ReceiptStore['claim']>;
    try {
        held = store.claim(receiptKey(request.sessionId, request.turnId), contentDigest(request));
    }
    catch {
        return failed('receipt-unavailable');
    }
    const receipt = held.receipt;
    let phase = 'authority-unavailable';
    try {
        if (receipt.digest !== contentDigest(request))
            return failed('receipt-conflict', receipt.ids);
        if (receipt.result)
            return receipt.result;
        // An unfinished intent never resumes: a previous request may have reached
        // the remote service even if it returned no page ID.
        receipt.result = failed('publication-incomplete', receipt.ids);
        held.save();
        const authority = await broker.authority();
        phase = 'authority-denied';
        if (authority.observationPublishingAuthorized !== true || typeof authority.spaceKey !== 'string'
            || !pageId(authority.spaceId))
            throw new Error();
        phase = 'space-lookup-unavailable';
        const space = await broker.space(authority.spaceKey);
        if (space && (!pageId(space.id) || typeof space.key !== 'string' || !/^[A-Za-z0-9_~]+$/.test(space.key)
            || space.key.toUpperCase() !== authority.spaceKey.trim().toUpperCase()))
            throw new Error();
        phase = space ? 'space-mismatch' : 'space-unresolved';
        if (!space || space.id !== authority.spaceId)
            throw new Error();
        phase = 'identity-unavailable';
        const author = await broker.identity();
        if (!author)
            throw new Error();
        // Every finding's links are checked before the first page is created.
        // 64 zeros is codex-obs saying its candidate search failed: UNKNOWN,
        // so nothing is created, as before the search moved out (issue #736).
        phase = 'related-unavailable';
        if (request.observations.some(finding => /^0{64}$/.test(finding.links.candidates)))
            throw new Error();
        phase = 'links-refused';
        const linked: Linked[] = [];
        for (const finding of request.observations)
            linked.push(await broker.links(space.key, request, finding));
        for (const [index, finding] of request.observations.entries()) {
            phase = 'placement-unresolved';
            const node = request.namedNode ?? finding.placement.project;
            const mapped = authority.nodes?.[node];
            if (!pageId(mapped))
                throw new Error();
            let app = '';
            if (!request.namedNode && finding.placement.app !== '-') app = finding.placement.app;
            if (app && !node.endsWith(' Apps'))
                throw new Error();
            const parent = await broker.parent(space.id, mapped, app);
            if (!pageId(parent))
                throw new Error();
            phase = 'related-unavailable';
            const publication = `<p>Publication: ${new Date().toISOString()}; session ${request.sessionId}; turn ${request.turnId}; ${broker.runtimeLabel}</p>`;
            const body = await broker.related(space.id, space.key, { ...finding, bodyStorage: finding.bodyStorage + publication }, parent, linked[index]);
            phase = 'create-unverified';
            receipt.result = failed(phase, receipt.ids);
            held.save();
            const id = await broker.create(space.id, finding, parent, body);
            if (!pageId(id) || receipt.ids.includes(id))
                throw new Error();
            receipt.ids.push(id);
            receipt.result = failed('publication-incomplete', receipt.ids);
            held.save();
            phase = 'labels-unverified';
            const labels = [...finding.labels, `session-${request.sessionId}`, broker.runtimeLabel];
            await broker.labels(id, labels);
            phase = 'readback-unverified';
            const target = await broker.read(id);
            if (target.id !== id || target.spaceId !== space.id || target.parentId !== parent || target.authorId !== author
                || target.title !== finding.title || target.body !== body
                || labels.some(label => !target.labels.includes(label))
                || target.labels.filter(label => label.startsWith('runtime-')).join() !== broker.runtimeLabel)
                throw new Error();
            phase = 'stitch-unverified';
            await broker.stitch(id, space.id, space.key, linked[index]);
        }
        receipt.result = `OBS-RESULT: wrote ${receipt.ids.length} ${receipt.ids.join(',')}`;
        held.save();
        return receipt.result;
    }
    catch (error) {
        const result = failed(phase === 'space-lookup-unavailable' ? lookupFailure(error) : phase, receipt.ids);
        try {
            receipt.result = result;
            held.save();
        }
        catch {
            return failed('receipt-unavailable', receipt.ids);
        }
        return result;
    }
    finally {
        try {
            held.release();
        }
        catch { /* A retained lock refuses a later call. */ }
    }
}
