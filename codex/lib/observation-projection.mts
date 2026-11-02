import fs from 'node:fs';
import path from 'node:path';
import type { InstallTransaction } from './install-transaction.mts';
export const OBSERVATION_SERVER = 'kherep_observations';
export interface ObservationProjection {
    entry: string;
    home: string;
}
// Issue #736: the read-only candidate search beside the publication tool. The
// one-tool table is the known predecessor the observation installer replaces.
export const OBSERVATION_TOOLS = ['publish_observations', 'related_candidates'] as const;
export const PREDECESSOR_OBSERVATION_TOOLS = ['publish_observations'] as const;
export function renderObservationPublisher(projection: ObservationProjection, node: string, tools: readonly string[] = OBSERVATION_TOOLS): string {
    return [`[mcp_servers.${OBSERVATION_SERVER}]`, 'enabled = true', 'required = false',
        `command = ${JSON.stringify(node)}`, `args = [${JSON.stringify(projection.entry)}]`,
        `env = { CODEX_HOME = ${JSON.stringify(projection.home)} }`, 'startup_timeout_sec = 30.0', 'tool_timeout_sec = 600.0',
        `enabled_tools = [${tools.map(tool => JSON.stringify(tool)).join(',')}]`,
        'env_vars = ["KHEREP_ATL_CRED_FILE_CODEX", "KHEREP_ATL_SITE", "KHEREP_PROFILE", "KHEREP_TWG_BIN", "NODE_EXTRA_CA_CERTS"]'].join('\n');
}
/** Flat broker import closure, excluding tests and with no dependency on Claude setup. */
export function observationFiles(repo: string): string[] {
    const root = path.join(repo, 'modules', 'atl-jira-brokers');
    const seen = new Set<string>();
    const queue = ['observation-stdio.mts'];
    while (queue.length) {
        const name = queue.shift()!;
        if (seen.has(name))
            continue;
        seen.add(name);
        const text = fs.readFileSync(path.join(root, name), 'utf8');
        for (const [, specifier] of text.matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+\.mts)['"]/g)) {
            if (path.basename(specifier) !== specifier)
                throw new Error('observation-import-outside-flat-broker');
            queue.push(specifier);
        }
    }
    return [...seen].sort();
}
export function copyObservationBroker(repo: string, workspace: string, transaction: InstallTransaction): string[] {
    return observationFiles(repo).map(name => transaction.copyFile(path.join(repo, 'modules', 'atl-jira-brokers', name), path.join(workspace, 'tools', name)));
}
export function renderObservationHook(source: string, workspace: string): string {
    const sentinel = 'const SELECTED_WORKSPACE = "__KHEREP_SELECTED_WORKSPACE__";';
    if (source.split(sentinel).length !== 2)
        throw new Error('Observation hook workspace sentinel must occur exactly once');
    return source.replace(sentinel, `const SELECTED_WORKSPACE = ${JSON.stringify(workspace)};`);
}
