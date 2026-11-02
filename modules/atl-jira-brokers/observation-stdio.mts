#!/usr/bin/env node
/** Local MCP surface: one bounded publication tool and one read-only candidate search, no arbitrary broker/CLI. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishObservations } from './observation-publisher.mts';
import { observationBroker } from './observation-broker.mts';
import { observationRequest } from './observation-policy.mts';
import { receiptStore } from './observation-receipt.mts';
import { checkObsResult } from './observation-result.mts';
export const OBSERVATION_TOOL = {
    name: 'publish_observations', description: 'Publish admissible observations once through the authorized Codex service-account broker; returns a safe OBS-RESULT receipt.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId', 'turnId', 'observations'], properties: {
            sessionId: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,79}$' }, turnId: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,79}$' },
            namedNode: { type: 'string', enum: ['Atlassian', 'Development/General', 'Development/DC Apps', 'Development/Forge Apps', 'Kherep', 'Operations'] },
            observations: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
                    required: ['title', 'bodyStorage', 'evidence', 'labels', 'placement', 'links'], properties: { title: { type: 'string', maxLength: 200 },
                        bodyStorage: { type: 'string', maxLength: 24000 }, evidence: { type: 'string', enum: ['confirmed', 'assumed', 'refuted', 'superseded'] },
                        labels: { type: 'array', items: { type: 'string' } }, placement: { type: 'object', additionalProperties: false, required: ['project', 'app'],
                            properties: { project: { type: 'string' }, app: { type: 'string', description: 'Exact app shelf child title, or - when no app applies.' } } },
                        links: { type: 'object', additionalProperties: false, required: ['candidates', 'approved'],
                            description: 'The related_candidates token for this title and the candidate ids you judged on topic, each with a one-sentence reason. An empty approved list links nothing.',
                            properties: { candidates: { type: 'string', pattern: '^[a-f0-9]{64}$' }, approved: { type: 'array', maxItems: 10, items: {
                                        type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: {
                                            id: { type: 'string', pattern: '^\\d{1,30}$' }, reason: { type: 'string', minLength: 10, maxLength: 300 } } } } } } } },
            }
        } },
};
// Issue #736: read-only. It searches, stores a receipt and returns candidate rows
// for codex-obs to judge; it never touches the publication journal.
export const RELATED_CANDIDATES_TOOL = {
    name: 'related_candidates', description: 'Search the knowledge space for pages a new observation might link to. Returns OBS-CANDIDATES with a token and one candidate row per page; judge every row on topic before publishing.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId', 'turnId', 'title', 'topic'], properties: {
            sessionId: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,79}$' }, turnId: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,79}$' },
            title: { type: 'string', maxLength: 200 }, topic: { type: 'string', minLength: 10, maxLength: 500, description: 'The finding sentence, not the title.' },
            placement: { type: 'object' } } },
};
type Publish = (value: unknown) => Promise<string>;
type Candidates = (value: unknown) => Promise<{ text: string; isError: boolean }>;
const CANDIDATES_RESULT = /^OBS-CANDIDATES: (?:ok [a-f0-9]{64} \d{1,3}|failed [a-z-]+)(?:\n|$)/;
// MCP Request.params._meta permits progressToken (string | number) and unknown
// extension keys. Metadata is ignored, never publication identity or arguments.
// The 4 KiB encoded limit is a local resource bound, not an MCP schema limit.
function validRequestMetadata(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    const metadata = value as Record<string, unknown>;
    if (Object.hasOwn(metadata, 'progressToken') && typeof metadata.progressToken !== 'string'
        && !(typeof metadata.progressToken === 'number' && Number.isFinite(metadata.progressToken)))
        return false;
    try {
        return Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= 4096;
    }
    catch {
        return false;
    }
}
export async function observationRpc(value: unknown, publish: Publish, candidates?: Candidates): Promise<unknown | null> {
    const r = value as {
        id?: unknown;
        jsonrpc?: unknown;
        method?: unknown;
        params?: {
            name?: unknown;
            arguments?: unknown;
            _meta?: unknown;
        };
    } | null;
    const id = typeof r?.id === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(r.id) || typeof r?.id === 'number' && Number.isSafeInteger(r.id) ? r.id : null;
    if (!r || r.jsonrpc !== '2.0' || typeof r.method !== 'string')
        return { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid-request' } };
    if (!Object.hasOwn(r, 'id'))
        return null;
    if (id === null)
        return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid-request' } };
    const result = (data: unknown) => ({ jsonrpc: '2.0', id, result: data });
    if (r.method === 'initialize')
        return result({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kherep-observations', version: '1.0.0' } });
    if (r.method === 'ping')
        return result({});
    if (r.method === 'tools/list')
        return result({ tools: [OBSERVATION_TOOL, RELATED_CANDIDATES_TOOL] });
    if (r.method === 'tools/call' && (!r.params || typeof r.params !== 'object' || Array.isArray(r.params)
        || Object.keys(r.params).some(key => !['name', 'arguments', '_meta'].includes(key))
        || typeof r.params.name !== 'string' || !Object.hasOwn(r.params, 'arguments')
        || Object.hasOwn(r.params, '_meta') && !validRequestMetadata(r.params._meta))) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid-parameters' } };
    }
    if (r.method === 'tools/call' && r.params?.name === 'publish_observations') {
        try {
            const receipt = await publish(r.params.arguments);
            const checked = typeof receipt === 'string' ? checkObsResult(receipt) : null;
            if (checked && 'status' in checked)
                return result({ content: [{ type: 'text', text: receipt }], isError: checked.status === 'failed' });
        }
        catch { }
        // No verified phase or complete ID evidence exists at this boundary.
        return { jsonrpc: '2.0', id, error: { code: -32603, message: 'publication-outcome-unknown' } };
    }
    if (r.method === 'tools/call' && r.params?.name === 'related_candidates' && candidates) {
        try {
            const outcome = await candidates(r.params.arguments);
            if (CANDIDATES_RESULT.test(outcome.text))
                return result({ content: [{ type: 'text', text: outcome.text }], isError: outcome.isError });
        }
        catch { }
        return { jsonrpc: '2.0', id, error: { code: -32603, message: 'candidates-outcome-unknown' } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method-unavailable' } };
}
export async function serveObservations(input: AsyncIterable<Buffer | string>, write: (value: string) => void, publish: Publish, candidates?: Candidates): Promise<void> {
    let pending = Buffer.alloc(0);
    for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        for (let i = 0; i < bytes.length; i++)
            if (bytes[i] === 10) {
                const line = Buffer.concat([pending, bytes.subarray(start, i)]);
                if (line.length > 600000)
                    throw new Error('invalid-request');
                pending = Buffer.alloc(0);
                start = i + 1;
                let value: unknown;
                try {
                    value = JSON.parse(line.toString('utf8'));
                }
                catch {
                    value = null;
                }
                const response = await observationRpc(value, publish, candidates);
                if (response)
                    write(`${JSON.stringify(response)}\n`);
            }
        pending = Buffer.concat([pending, bytes.subarray(start)]);
        if (pending.length > 600000)
            throw new Error('invalid-request');
    }
    if (pending.length)
        throw new Error('invalid-request');
}
async function main() {
    if (process.argv.length !== 2)
        throw new Error('invalid-request');
    const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    // Lazy broker construction preserves the empty-finding zero-I/O contract.
    await serveObservations(process.stdin, line => process.stdout.write(line), async (request) => {
        const validated = observationRequest(request);
        if (!validated)
            return 'OBS-RESULT: failed invalid-request';
        if (!validated.observations.length)
            return 'OBS-RESULT: empty no-admissible-findings';
        return publishObservations(validated, observationBroker(home), receiptStore(path.join(home, '.cache', 'observation-publisher')));
    }, async (request) => observationBroker(home).candidates(request));
}
let mainModule = false;
try {
    mainModule = import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href;
}
catch { }
if (mainModule)
    void main().catch(() => { process.stderr.write('observation-adapter-unavailable\n'); process.exitCode = 1; });
