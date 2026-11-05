import { checkObsCandidate } from './observation-candidate.mts';
export type Finding = {
    title: string;
    bodyStorage: string;
    evidence: string;
    labels: string[];
    placement: {
        project: string;
        app: string;
    };
    // Issue #736: the related_candidates token and the ids codex-obs approved.
    links: FindingLinks;
};
export type FindingLinks = {
    candidates: string;
    approved: { id: string; reason: string }[];
};
export type ObservationRequest = {
    sessionId: string;
    turnId: string;
    observations: Finding[];
    namedNode?: string;
};
export const NODES = new Set(['Atlassian', 'Development/General', 'Development/DC Apps',
    'Development/Forge Apps', 'Kherep', 'Operations']);
export const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value);
export const pageId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,30}$/.test(value);
// Model-authored storage is prose only. Related anchors are added by the
// broker after validation, never accepted from the caller.
const PROSE_TAGS = new Set(['p','pre','code','h1','h2','h3','h4','h5','h6',
    'ul','ol','li','blockquote','strong','em','b','i','s','u','del','ins','sub','sup',
    'table','thead','tbody','tfoot','tr','td','th','br','hr']);
export function ordinaryXhtml(storage: string): boolean {
    const open: string[] = [];
    let cursor = 0;
    while (true) {
        const start = storage.indexOf('<', cursor);
        if (start === -1) break;
        const end = storage.indexOf('>', start + 1);
        if (end === -1) return false;
        const tag = storage.slice(start, end + 1);
        cursor = end + 1;
        const parsed = /^<(\/?)([a-z][a-z0-9]*)\s*(\/?)>$/.exec(tag);
        if (!parsed || !PROSE_TAGS.has(parsed[2]) || parsed[1] && parsed[3]) return false;
        const [,closing,name,selfClosing] = parsed;
        if (closing) { if (open.pop() !== name) return false; }
        else if (!selfClosing && name !== 'br' && name !== 'hr') open.push(name);
    }
    return open.length === 0;
}
const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value) && typeof value === 'object'
    && !Array.isArray(value) && Object.keys(value as object).sort((left, right) => Number(left > right) - Number(left < right)).join() === keys.join();
function linksShape(links: unknown): links is FindingLinks {
    return exactKeys(links, ['approved', 'candidates']) && typeof links.candidates === 'string' && /^[a-f0-9]{64}$/.test(links.candidates)
        && Array.isArray(links.approved) && links.approved.length <= 10 && links.approved.every(item => exactKeys(item, ['id', 'reason'])
        && pageId(item.id) && typeof item.reason === 'string' && item.reason.length <= 1000);
}
export function observationRequest(value: unknown): ObservationRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const r = value as ObservationRequest;
    if (Object.keys(r).some(k => !['sessionId', 'turnId', 'observations', 'namedNode'].includes(k))
        || !safeId(r.sessionId) || !safeId(r.turnId) || !Array.isArray(r.observations) || r.observations.length > 20
        || (r.namedNode !== undefined && !NODES.has(r.namedNode)))
        return null;
    // The shared candidate check knows the five content keys; links are the
    // adapter's own sixth key and are checked here, by shape only. Whether the
    // decisions fit the receipt is the publisher's links-refused phase.
    const plain = r.observations.map(f => f && typeof f === 'object' && !Array.isArray(f) ? Object.fromEntries(Object.entries(f).filter(([key]) => key !== 'links')) : f);
    if ('problem' in checkObsCandidate(JSON.stringify({ observations: plain })) || !r.observations.every(f => linksShape(f.links)))
        return null;
    for (const f of r.observations) {
        if (f.title.length > 200 || f.bodyStorage.length > 24000
            || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(f.title + f.bodyStorage)
            || !ordinaryXhtml(f.bodyStorage)
            || !NODES.has(r.namedNode ?? f.placement.project)
            || f.placement.app.length > 120)
            return null;
    }
    return r;
}
export function failed(code: string, ids: readonly string[] = []): string {
    return `OBS-RESULT: failed ${code}${ids.length ? ` created=${ids.join(',')}` : ''}`;
}
