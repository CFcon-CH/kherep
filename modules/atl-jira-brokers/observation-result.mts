/** Pure, privacy-safe final handback parser. Never echoes rejected input. */
export type ObsResult = {
    status: 'wrote' | 'empty' | 'failed';
    ids: string[];
} | {
    problem: string;
};
export const OBS_FAILURES = new Set(['invalid-request', 'authority-unavailable', 'authority-denied',
    'space-mismatch', 'space-lookup-unavailable', 'space-unresolved', 'space-lookup-bindings-missing',
    'space-lookup-network-unavailable', 'space-lookup-timeout', 'placement-unresolved', 'identity-unavailable', 'links-refused', 'related-unavailable',
    'create-unverified', 'labels-unverified', 'readback-unverified', 'stitch-unverified',
    'receipt-unavailable', 'receipt-conflict', 'publication-incomplete', 'broker-unavailable']);
export function checkObsResult(text: string): ObsResult {
    const bad = { problem: 'the result is not one strict publication receipt' };
    if (text.length > 1200)
        return bad;
    const line = text.trim();
    if (line === 'OBS-RESULT: empty no-admissible-findings')
        return { status: 'empty', ids: [] };
    const wrote = /^OBS-RESULT: wrote ([1-9]\d?) (\d{1,30}(?:,\d{1,30})*)$/.exec(line);
    const failed = /^OBS-RESULT: failed ([a-z-]+)(?: created=(\d{1,30}(?:,\d{1,30})*))?$/.exec(line);
    if (!wrote && (!failed || !OBS_FAILURES.has(failed[1])))
        return bad;
    const ids = (wrote?.[2] ?? failed?.[2] ?? '').split(',').filter(Boolean);
    if (ids.length > 20 || new Set(ids).size !== ids.length || (wrote && Number(wrote[1]) !== ids.length))
        return bad;
    return { status: wrote ? 'wrote' : 'failed', ids };
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
