/** Observation-only upgrade. No registry, private profile, setup or model refresh. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { InstallTransaction } from './lib/install-transaction.mts';
import { renderAgent } from './lib/component-render.mts';
import { selectModelResolution } from './lib/model-install-state.mts';
import { copyObservationBroker, observationFiles, PREDECESSOR_OBSERVATION_TOOLS, renderObservationPublisher, renderObservationHook } from './lib/observation-projection.mts';
import { copyObservationSnapshot, observationHash } from './lib/observation-source.mts';
import { stableNodePath } from './lib/node-path.mts';
import { observationWiring } from './lib/observation-wiring.mts';
import { preserveExternalPostToolPositions } from './lib/post-tool-trust-position.mts';
const START = '# >>> Kherep Codex Maestro >>>', END = '# <<< Kherep Codex Maestro <<<';
const HOOKS: Record<string, string> = {
    'obs-result-check.mts': 'codex-obs-result-check.mts', 'kherep-maestro-context.mts': '../kherep-maestro-context.mts',
    'confluence-delivery-check.mts': 'codex-confluence-delivery-check.mts',
    'observation-stop.mts': 'codex-observation-stop.mts', 'observation-turn-completion.mts': 'codex-observation-turn-completion.mts',
    'hook-integrity-repair.mts': 'hook-integrity-repair.mts', 'hook-integrity-sources.mts': 'hook-integrity-sources.mts',
};
const read = (file: string) => fs.readFileSync(file, 'utf8');
function replaceKnown(text: string, old: string, next: string): string {
    const current = text.split(next).length - 1, previous = old === next ? 0 : text.split(old).length - 1;
    if (current === 1 && previous === 0)
        return text;
    if (current > 0)
        throw new Error('observation-predecessor-unrecognized');
    if (!old || text.split(old).length !== 2)
        throw new Error('observation-predecessor-unrecognized');
    return text.replace(old, next);
}
function section(text: string): string { return text.slice(text.indexOf('## Session observations'), text.indexOf('## Linking')); }
export interface ObservationInstallOptions {
    codexHome: string;
    workspace: string;
    nodePath?: string;
    repoRoot?: string;
    afterWrite?: (writes: number) => void;
}
function prepareObservationPublisher(options: ObservationInstallOptions) {
    const home = path.resolve(options.codexHome), workspace = path.resolve(options.workspace);
    const repo = path.resolve(options.repoRoot ?? path.join(import.meta.dirname, '..'));
    if (!path.isAbsolute(options.codexHome) || !path.isAbsolute(options.workspace))
        throw new Error('observation-explicit-targets-required');
    const predecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-predecessor.json'))) as Record<string, string>;
    const headerPredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-header-predecessor.json'))) as Record<string, string>;
    const lookupPredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-lookup-predecessor.json'))) as Record<string, string>;
    const prosePredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-prose-predecessor.json'))) as Record<string, string>;
    const scopedPredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-scoped-revision-predecessor.json'))) as Record<string, string>;
    const identityPredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-turn-identity-predecessor.json'))) as Record<string, string>;
    const pilotPredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-turn-identity-pilot-predecessor.json'))) as Record<string, string>;
    const workspacePredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-context-workspace-predecessor.json'))) as Record<string, string>;
    // Issue #701: the 764200b hook-integrity-sources.mts, before the dispatch guard's worker-brief lib.
    const workerPredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-worker-brief-predecessor.json'))) as Record<string, string>;
    // Issue #730: frozen exact 57c0c471 bytes, before worker-only handbacks.
    const handbackPredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-handback-predecessor.json'))) as Record<string, string>;
    // Issue #736: frozen exact f34b66f bytes, before candidates-first linking.
    const linkingPredecessor = JSON.parse(read(path.join(repo, 'codex', 'parity', 'observation-linking-predecessor.json'))) as Record<string, string>;
    const source = (relative: string) => read(path.join(repo, relative));
    const configFile = path.join(home, 'config.toml'), beforeConfig = read(configFile);
    const start = beforeConfig.indexOf(START), end = beforeConfig.indexOf(END);
    if (start < 0 || end < start || beforeConfig.split(START).length !== 2 || beforeConfig.split(END).length !== 2)
        throw new Error('observation-managed-block-unrecognized');
    const wiring = observationWiring(beforeConfig, home, options.nodePath ?? stableNodePath(process.execPath), workspace);
    const receipt = JSON.parse(read(path.join(home, 'orchestra', 'parity-receipt.json')));
    const resolution = selectModelResolution(source('codex/parity/model-policy.toml'), { existing: receipt.modelResolution });
    const defaults = receipt.projection?.agentDefaults as Record<string, {
        role?: string;
        model?: string;
        reasoning?: string;
    }>;
    const observers = Object.entries(defaults ?? {}).filter(([, v]) => v.role === 'observer');
    if (observers.length !== 1)
        throw new Error('observation-role-unrecognized');
    const [agentName, agent] = observers[0];
    if (!/^[a-z0-9-]+$/.test(agentName) || agent.model !== resolution.roles.observer.model || agent.reasoning !== 'low')
        throw new Error('observation-pin-unrecognized');
    const capabilities = JSON.parse(read(path.join(home, 'hooks', 'parity', 'capabilities.json')));
    const pin = capabilities.agents?.['claude-obs'];
    if (pin?.as !== agentName || pin.enforcePin !== true || pin.sandbox !== 'read-only' || pin.model !== agent.model || pin.reasoning !== 'low')
        throw new Error('observation-pin-unrecognized');
    const agentOptions = { model: agent.model, reasoning: 'low', sandbox: 'read-only' };
    const agentFile = path.join(home, 'agents', `${agentName}.toml`), beforeAgent = read(agentFile);
    const newAgent = renderAgent(agentName, source('codex/agents/codex-obs.md'), agentOptions);
    if (beforeAgent !== newAgent && ![predecessor, scopedPredecessor, identityPredecessor, pilotPredecessor, handbackPredecessor, linkingPredecessor].some(known => beforeAgent === renderAgent(agentName, known['codex/agents/codex-obs.md'], agentOptions)))
        throw new Error('observation-agent-drift');
    const changes = new Map<string, string>();
    changes.set(agentFile, newAgent);
    const hookDir = path.join(home, 'hooks', 'kherep-maestro');
    for (const [name, target] of Object.entries(HOOKS)) {
        const relative = `codex/hooks/${name}`, file = path.resolve(hookDir, target);
        const render = (text: string) => name.startsWith('observation-') ? renderObservationHook(text, workspace) : text;
        const next = render(source(relative));
        if (fs.existsSync(file) && read(file) !== next && read(file) !== render(predecessor[relative]) && read(file) !== lookupPredecessor[relative]
            && (scopedPredecessor[relative] === undefined || read(file) !== render(scopedPredecessor[relative]))
            && (handbackPredecessor[relative] === undefined || read(file) !== render(handbackPredecessor[relative]))
            && (linkingPredecessor[relative] === undefined || read(file) !== render(linkingPredecessor[relative]))
            && read(file) !== identityPredecessor[relative] && read(file) !== workspacePredecessor[relative] && read(file) !== workerPredecessor[relative])
            throw new Error('observation-hook-drift');
        changes.set(file, next);
    }
    for (const [target, from] of [['obs-candidate-policy.mts', 'observation-candidate.mts'], ['obs-result-policy.mts', 'observation-result.mts']]) {
        const file = path.join(hookDir, target), next = source(`modules/atl-jira-brokers/${from}`);
        const old = target === 'obs-candidate-policy.mts' ? [predecessor['codex/hooks/obs-candidate-policy.mts'], scopedPredecessor[`modules/atl-jira-brokers/${from}`]]
            : [lookupPredecessor[`modules/atl-jira-brokers/${from}`], handbackPredecessor[`modules/atl-jira-brokers/${from}`], linkingPredecessor[`modules/atl-jira-brokers/${from}`]];
        if (fs.existsSync(file) && read(file) !== next && !old.includes(read(file)))
            throw new Error('observation-helper-drift');
        changes.set(file, next);
    }
    const agentsFile = path.join(home, 'AGENTS.md');
    const line = (text: string) => text.split('\n').find(row => row.startsWith('- After a completed turn,'))!;
    const oldAgents = [predecessor, handbackPredecessor, linkingPredecessor].map(known => known['codex/AGENTS.maestro.md'])
        .find(known => read(agentsFile).includes(line(known))) ?? predecessor['codex/AGENTS.maestro.md'];
    changes.set(agentsFile, replaceKnown(read(agentsFile), line(oldAgents), line(source('codex/AGENTS.maestro.md'))));
    const routingFile = path.join(home, 'orchestra', 'ROUTING.md'), routing = read(routingFile);
    const oldRouting = [predecessor, scopedPredecessor, handbackPredecessor, linkingPredecessor].map(known => section(known['codex/ROUTING.md'])).find(old => routing.includes(old)) ?? section(predecessor['codex/ROUTING.md']);
    changes.set(routingFile, replaceKnown(routing, oldRouting, section(source('codex/ROUTING.md'))));
    const table = renderObservationPublisher({ entry: path.join(workspace, 'tools', 'observation-stdio.mts'), home }, wiring.node);
    let config = beforeConfig;
    for (const edit of [...wiring.contextEdits].reverse())
        config = config.slice(0, edit.start) + edit.after + config.slice(edit.end);
    const commandDelta = wiring.contextEdits.reduce((sum, edit) => sum + edit.after.length - edit.before.length, 0);
    const contextConfig = config;
    let insertedText = '', insertedAt = 0, swapped: { at: number; before: string } | null = null;
    if (config.includes('[mcp_servers.kherep_observations]')) {
        // Issue #736: the exact one-tool table is a known predecessor and is
        // replaced in place; any other table is still drift.
        const previous = renderObservationPublisher({ entry: path.join(workspace, 'tools', 'observation-stdio.mts'), home }, wiring.node, PREDECESSOR_OBSERVATION_TOOLS);
        const managed = config.slice(start, end + commandDelta);
        if (config.split('[mcp_servers.kherep_observations]').length !== 2 || (!managed.includes(table) && managed.split(previous).length !== 2))
            throw new Error('observation-tool-table-drift');
        if (!managed.includes(table)) {
            const at = start + managed.indexOf(previous);
            swapped = { at, before: previous };
            config = config.slice(0, at) + table + config.slice(at + previous.length);
        }
    }
    else {
        const originalInsert = wiring.messagingStart ?? end;
        const precedingDelta = wiring.contextEdits.filter(edit => edit.end <= originalInsert)
            .reduce((sum, edit) => sum + edit.after.length - edit.before.length, 0);
        const insert = originalInsert + precedingDelta;
        insertedAt = insert;
        insertedText = wiring.messagingStart === undefined ? `\n${table}\n` : `${table}\n\n`;
        config = config.slice(0, insert) + insertedText + config.slice(insert);
    }
    preserveExternalPostToolPositions(beforeConfig, config, START, END);
    changes.set(configFile, config);
    for (const name of observationFiles(repo)) {
        const file = path.join(workspace, 'tools', name);
        const relative = `modules/atl-jira-brokers/${name}`;
        if (fs.existsSync(file) && read(file) !== source(relative) && read(file) !== predecessor[relative] && read(file) !== lookupPredecessor[relative]
            && read(file) !== headerPredecessor[relative] && read(file) !== prosePredecessor[relative] && read(file) !== scopedPredecessor[relative] && read(file) !== handbackPredecessor[relative]
            && read(file) !== linkingPredecessor[relative])
            throw new Error('observation-broker-drift');
    }
    // Reverse exactly the validated command-line edits and the optional table insertion.
    // No managed-block-wide difference is allowed by this preservation proof.
    let restored = config;
    if (swapped) {
        if (restored.slice(swapped.at, swapped.at + table.length) !== table) throw new Error('observation-config-preservation-failed');
        restored = restored.slice(0, swapped.at) + swapped.before + restored.slice(swapped.at + table.length);
    }
    if (insertedText) {
        if (restored.slice(insertedAt, insertedAt + insertedText.length) !== insertedText) throw new Error('observation-config-preservation-failed');
        restored = restored.slice(0, insertedAt) + restored.slice(insertedAt + insertedText.length);
    }
    if (restored !== contextConfig) throw new Error('observation-config-preservation-failed');
    let delta = commandDelta;
    for (const edit of [...wiring.contextEdits].reverse()) {
        delta -= edit.after.length - edit.before.length;
        const at = edit.start + delta;
        if (restored.slice(at, at + edit.after.length) !== edit.after) throw new Error('observation-config-preservation-failed');
        restored = restored.slice(0, at) + edit.before + restored.slice(at + edit.after.length);
    }
    if (restored !== beforeConfig) throw new Error('observation-config-preservation-failed');
    return { home, workspace, repo, changes, config, newAgent, agentFile, capabilities,
        changedContextDefinitions: ['UserPromptSubmit', 'SessionStart'] };
}
export function checkObservationPublisher(options: ObservationInstallOptions) {
    const { changedContextDefinitions } = prepareObservationPublisher(options);
    return { contextWorkspaceBinding: 'installer-workspace', changedContextDefinitions, nativeTrustReview: 'required', predecessorRecognized: true, unknownObservationDrift: false, pinUnchanged: true, sandbox: 'read-only', nativeToolDiscovery: 'UNKNOWN' };
}
export function installObservationPublisher(options: ObservationInstallOptions) {
    const { home, workspace, repo, changes, config, newAgent, agentFile, capabilities, changedContextDefinitions } = prepareObservationPublisher(options);
    const source = (relative: string) => read(path.join(repo, relative));
    const backup = path.join(home, 'backups', 'kherep-observations', `${Date.now()}-${process.pid}`);
    let writes = 0;
    const onWrite = () => options.afterWrite?.(++writes);
    const homeTx = new InstallTransaction(home, backup, onWrite), workspaceTx = new InstallTransaction(workspace, path.join(backup, 'workspace'), onWrite);
    const controlPointer = path.join(home, 'orchestra', 'control-plane-source.json');
    const oldPointer = fs.existsSync(controlPointer) ? read(controlPointer) : null;
    const hookStateFile = path.join(home, 'hooks.state.json');
    const oldState = fs.existsSync(hookStateFile) ? read(hookStateFile) : null;
    try {
        for (const [file, text] of changes)
            homeTx.writeFile(file, text);
        copyObservationBroker(repo, workspace, workspaceTx);
        const manifest = copyObservationSnapshot(repo, home, homeTx);
        const brokerHashes = Object.fromEntries(observationFiles(repo).map(name => [name, observationHash(read(path.join(repo, 'modules', 'atl-jira-brokers', name)))]));
        const hashes = Object.fromEntries([...changes].map(([file, text]) => [path.relative(home, file), observationHash(text)]));
        const brokerMatches = Object.entries(brokerHashes).every(([name, hash]) => observationHash(read(path.join(workspace, 'tools', name))) === hash);
        const snapshotMatches = read(path.join(home, 'orchestra', 'observation-source', 'manifest.json')) === JSON.stringify(manifest)
            && Object.entries(manifest).every(([from, hash]) => observationHash(read(path.join(home, 'orchestra', 'observation-source', from))) === hash);
        const pinMatches = read(agentFile) === newAgent && JSON.stringify(JSON.parse(read(path.join(home, 'hooks', 'parity', 'capabilities.json')))) === JSON.stringify(capabilities);
        const report = { schemaVersion: 1, predecessorRecognized: true, installedHashesMatch: brokerMatches && snapshotMatches && [...changes].every(([file, text]) => read(file) === text),
            contextWorkspaceBinding: 'installer-workspace', changedContextDefinitions,
            nativeTrustReview: 'required', unrelatedConfigUnchanged: true,
            hookStateUnchanged: (fs.existsSync(hookStateFile) ? read(hookStateFile) : null) === oldState,
            controlPlanePointerUnchanged: (fs.existsSync(controlPointer) ? read(controlPointer) : null) === oldPointer,
            externalHookPositionsUnchanged: true, integritySourceMatches: snapshotMatches, pinUnchanged: pinMatches, sandbox: 'read-only',
            nativeToolDiscovery: 'UNKNOWN', livePublication: 'UNTESTED', hashes, brokerHashes, source: { kind: 'content-manifest', sha256: observationHash(JSON.stringify({ hashes, brokerHashes, manifest })) } };
        if (!report.installedHashesMatch || !report.unrelatedConfigUnchanged || !report.hookStateUnchanged || !report.controlPlanePointerUnchanged || !report.pinUnchanged || !report.integritySourceMatches)
            throw new Error('observation-target-verification-failed');
        homeTx.writeFile(path.join(home, 'orchestra', 'observation-install-receipt.json'), JSON.stringify(report, null, 2) + '\n');
        return { backupRoot: backup, receipt: report };
    }
    catch {
        homeTx.rollback();
        workspaceTx.rollback();
        throw new Error('observation-install-failed-rolled-back');
    }
}
let main = false;
try {
    main = import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href;
}
catch { }
if (main) {
    try {
        const args = process.argv.slice(2);
        const check = args[0] === '--check';
        if (check)
            args.shift();
        if (args.length !== 4 || args[0] !== '--codex-home' || args[2] !== '--workspace')
            throw new Error();
        const options = { codexHome: args[1], workspace: args[3] };
        const result = check ? checkObservationPublisher(options) : installObservationPublisher(options).receipt;
        process.stdout.write(JSON.stringify(result) + '\n');
    }
    catch (error) {
        const allowed = new Set(['observation-explicit-targets-required', 'observation-managed-block-unrecognized', 'observation-role-unrecognized',
            'observation-pin-unrecognized', 'observation-agent-drift', 'observation-hook-drift', 'observation-helper-drift', 'observation-tool-table-drift',
            'observation-context-wiring-drift', 'observation-config-preservation-failed', 'observation-result-wiring-drift', 'observation-broker-drift', 'observation-predecessor-unrecognized', 'observation-install-failed-rolled-back']);
        const message = error instanceof Error && allowed.has(error.message) ? error.message : 'observation-upgrade-unavailable';
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
