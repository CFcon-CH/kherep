/** Pure, privacy-safe final handback parser. Never echoes rejected input. */
export type ObsResult = {
    status: 'wrote' | 'empty' | 'failed';
    ids: string[];
    // Issue #989: the canonical `why=` text, present only when the line carries one.
    why?: string;
} | {
    problem: string;
};
export const OBS_FAILURES = new Set(['invalid-request', 'authority-unavailable', 'authority-denied',
    'space-mismatch', 'space-lookup-unavailable', 'space-unresolved', 'space-lookup-bindings-missing',
    'space-lookup-network-unavailable', 'space-lookup-timeout', 'placement-unresolved', 'identity-unavailable', 'links-refused', 'related-unavailable',
    'create-unverified', 'labels-unverified', 'readback-unverified', 'stitch-unverified',
    'receipt-unavailable', 'receipt-conflict', 'publication-incomplete', 'broker-unavailable']);
// Issue #989: the fixed codes a failure may name per finding, in priority order.
// The receipt tier (first three) short-circuits; `unknown` is any other refusal.
export const OBS_WHY: Record<string, readonly string[]> = {
    'links-refused': ['receipt-missing', 'receipt-unreadable', 'receipt-malformed', 'another-turn', 'another-title', 'another-space',
        'receipt-undated', 'receipt-expired', 'receipt-future', 'id-invalid', 'not-candidate', 'duplicate-id', 'reason-invalid', 'unknown'],
    'invalid-request': ['reason-invalid'],
};
export type ObsWhyEntry = { position: number; code: string };
/** The canonical why text: by finding position, then code priority, no duplicates, at most two codes per finding. */
export function obsWhy(failure: string, entries: readonly ObsWhyEntry[]): string {
    const vocabulary = Object.hasOwn(OBS_WHY, failure) ? OBS_WHY[failure] : [];
    const kept = entries.filter(entry => Number.isInteger(entry.position) && entry.position >= 1 && entry.position <= 20 && vocabulary.includes(entry.code))
        .sort((left, right) => left.position - right.position || vocabulary.indexOf(left.code) - vocabulary.indexOf(right.code));
    const out: string[] = [];
    for (const { position, code } of kept) {
        const entry = `${position}:${code}`;
        const prior = out.filter(kept => kept.startsWith(`${position}:`));
        if (prior.length < 2 && !prior.includes(entry))
            out.push(entry);
    }
    return out.join(',');
}
// Whole-line `unknown` is links-refused only; every other why text must re-render byte for byte.
function canonicalWhy(failure: string, why: string): boolean {
    if (why === 'unknown')
        return failure === 'links-refused';
    const entries = why.split(',').map(entry => /^([1-9]\d?):([a-z-]+)$/.exec(entry));
    return entries.every(Boolean) && obsWhy(failure, entries.map(entry => ({ position: Number(entry![1]), code: entry![2] }))) === why;
}
export function checkObsResult(text: string): ObsResult {
    const bad = { problem: 'the result is not one strict publication receipt' };
    if (text.length > 1200)
        return bad;
    const line = text.trim();
    if (line === 'OBS-RESULT: empty no-admissible-findings')
        return { status: 'empty', ids: [] };
    const wrote = /^OBS-RESULT: wrote ([1-9]\d?) (\d{1,30}(?:,\d{1,30})*)$/.exec(line);
    // `created=` and `why=` never appear together: a why phase precedes the first create.
    const failed = /^OBS-RESULT: failed ([a-z-]+)(?: created=(\d{1,30}(?:,\d{1,30})*)| why=([a-z0-9:,-]{1,880}))?$/.exec(line);
    if (!wrote && (!failed || !OBS_FAILURES.has(failed[1])))
        return bad;
    const why = failed?.[3];
    if (why !== undefined && !canonicalWhy(failed![1], why))
        return bad;
    const ids = (wrote?.[2] ?? failed?.[2] ?? '').split(',').filter(Boolean);
    if (ids.length > 20 || new Set(ids).size !== ids.length || (wrote && Number(wrote[1]) !== ids.length))
        return bad;
    return why === undefined ? { status: wrote ? 'wrote' : 'failed', ids } : { status: 'failed', ids, why };
}

/** Worker reports are not adapter receipts and must never enter the journal. */
export type ObsAttempt = {
    status: 'attempt-failed';
    reason: string;
    detail: string;
    publication: 'not-attempted' | 'unknown';
    created: 'none' | 'unknown';
};
/** Issue #731 PR-B. One page of the optional worker line `OBS-EVIDENCE: <id>:<n|->:<label>[,...]`. */
export type ObsEvidence = { id: string; finding: number | null; evidence: string };
/** A receipt with the worker's evidence line: its entries, or null when the line is malformed. */
export type ObsLabelled = Extract<ObsResult, { status: string }> & { evidence: ObsEvidence[] | null };
export type ObsHandback = ObsResult | ObsLabelled | ObsAttempt;
const EVIDENCE_ENTRY = /^(\d{1,30}):([1-9]\d{0,3}|-):(confirmed|assumed|refuted|superseded)$/;
function evidenceLine(line: string): ObsEvidence[] | null {
    const entries = line.slice('OBS-EVIDENCE:'.length).split(',').map(entry => EVIDENCE_ENTRY.exec(entry.trim()));
    if (line.length > 1200 || entries.length > 20 || entries.some(entry => !entry)) return null;
    const list = entries.map(entry => ({ id: entry![1], finding: entry![2] === '-' ? null : Number(entry![2]), evidence: entry![3] }));
    return new Set(list.map(entry => entry.id)).size === list.length ? list : null;
}
export function checkObsHandback(text: string): ObsHandback {
    // The evidence line is the worker's, never part of the adapter receipt, so the
    // receipt parser stays strict; a malformed evidence line never refuses the
    // receipt it follows (null entries, and the join warns).
    const lines = text.split(/\r?\n/).filter(row => row.trim());
    if (lines.length === 2 && lines[1].trim().startsWith('OBS-EVIDENCE:')) {
        const labelled = checkObsResult(lines[0]);
        if ('status' in labelled) return { ...labelled, evidence: evidenceLine(lines[1].trim()) };
    }
    const receipt = checkObsResult(text);
    if ('status' in receipt) return receipt;
    const bad = { problem: 'the result is not one strict publication receipt or worker attempt' };
    if (text.length > 1200) return bad;
    const match = /^OBS-ATTEMPT: failed ([a-z-]+) detail=([a-z-]+) publication=(not-attempted|unknown) created=(none|unknown)$/.exec(text.trim());
    if (!match) return bad;
    const [, reason, detail, publication, created] = match;
    const preflight = ['missing-turn-identity', 'tool-unavailable'].includes(reason);
    const details: Record<string, string[]> = {
        'tool-refused': ['unacceptable-risk', 'unknown'],
        'tool-error': ['unknown'],
        'protocol-error': ['invalid-request', 'invalid-parameters', 'method-unavailable', 'publication-outcome-unknown', 'unknown'],
        'invalid-tool-response': ['unknown'],
        'evidence-unavailable': ['unknown'],
    };
    if (preflight ? detail !== 'none' || publication !== 'not-attempted' || created !== 'none'
        : !Object.hasOwn(details, reason) || !details[reason].includes(detail) || publication !== 'unknown' || created !== 'unknown') return bad;
    return { status: 'attempt-failed', reason, detail, publication: preflight ? 'not-attempted' : 'unknown', created: preflight ? 'none' : 'unknown' };
}
