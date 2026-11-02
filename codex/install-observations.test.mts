import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from './install.mts';
import { installObservationPublisher, checkObservationPublisher } from './install-observations.mts';
import { fixtureModelOptions } from './lib/model-policy.fixture.mts';
import { renderAgent } from './lib/component-render.mts';
import { renderObservationHook, renderObservationPublisher, observationFiles } from './lib/observation-projection.mts';
import { OBSERVATION_SOURCES, observationSnapshot, observationHash } from './lib/observation-source.mts';
import { observationSource } from './hooks/hook-integrity-repair.mts';
import { scanDocument } from './lib/toml-block-structure.mts';
const REPO = path.resolve(import.meta.dirname, '..');
const predecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex', 'parity', 'observation-predecessor.json'), 'utf8')) as Record<string, string>;
const identityPredecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-turn-identity-predecessor.json'), 'utf8')) as Record<string, string>;
const pilotPredecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-turn-identity-pilot-predecessor.json'), 'utf8')) as Record<string, string>;
const scopedPredecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-scoped-revision-predecessor.json'), 'utf8')) as Record<string, string>;
const workspacePredecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-context-workspace-predecessor.json'), 'utf8')) as Record<string, string>;
const c1Predecessor = { 'codex/agents/codex-obs.md': fs.readFileSync(path.join(REPO, 'codex/agents/codex-obs.md'), 'utf8'), ...workspacePredecessor };
const identityVersions = [['60cde716 main', identityPredecessor], ['9241eba pilot', pilotPredecessor], ['c1af727 current', c1Predecessor]] as const;
function fixture(t: {
    after(fn: () => void): void;
}, messaging = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    const registry = path.join(root, 'synthetic-registry.json');
    fs.writeFileSync(registry, '{"mcpServers":{}}', { mode: 0o600 });
    const installOptions = { ...fixtureModelOptions(), codexHome: home, workspace, claudeRegistryFile: registry, claudeConfigDir: path.join(root, 'empty-claude'),
        nodePath: process.execPath, skipPluginRegistration: true, resolveRegistryRuntime: () => ({}), log: () => { }, controlPlaneOutbox: path.join(root, 'outbox'), messagingClient: messaging };
    install(installOptions);
    const configFile = path.join(home, 'config.toml');
    let config = fs.readFileSync(configFile, 'utf8');
    const table = renderObservationPublisher({ entry: path.join(workspace, 'tools', 'observation-stdio.mts'), home }, process.execPath);
    config = config.replace(messaging ? `${table}\n\n` : `\n\n${table}`, '');
    config = config.replaceAll(JSON.stringify(` \"--workspace-b64\" \"${Buffer.from(workspace).toString('base64url')}\"`).slice(1, -1), '');
    assert.doesNotMatch(config, /mcp_servers\.kherep_observations/);
    fs.writeFileSync(configFile, config + '\n[mcp_servers.operator_fixture]\ncommand = "preserve"\n');
    const agentFile = path.join(home, 'agents', 'codex-obs.toml');
    const agent = fs.readFileSync(agentFile, 'utf8');
    const model = JSON.parse(/^model = (.*)$/m.exec(agent)![1]);
    fs.writeFileSync(agentFile, renderAgent('codex-obs', predecessor['codex/agents/codex-obs.md'], { model, reasoning: 'low', sandbox: 'read-only' }));
    for (const [source, target] of [['obs-result-check.mts', 'codex-obs-result-check.mts'], ['obs-candidate-policy.mts', 'obs-candidate-policy.mts'],
        ['confluence-delivery-check.mts', 'codex-confluence-delivery-check.mts'], ['hook-integrity-repair.mts', 'hook-integrity-repair.mts'], ['hook-integrity-sources.mts', 'hook-integrity-sources.mts'],
        ['observation-stop.mts', 'codex-observation-stop.mts'], ['observation-turn-completion.mts', 'codex-observation-turn-completion.mts']]) {
        let sourceText = predecessor[`codex/hooks/${source}`];
        if (source.startsWith('observation-'))
            sourceText = renderObservationHook(sourceText, workspace);
        fs.writeFileSync(path.join(home, 'hooks', 'kherep-maestro', target), sourceText);
    }
    fs.writeFileSync(path.join(home, 'hooks', 'kherep-maestro-context.mts'), predecessor['codex/hooks/kherep-maestro-context.mts']);
    const routing = path.join(home, 'orchestra', 'ROUTING.md');
    const text = fs.readFileSync(routing, 'utf8');
    const section = (s: string) => s.slice(s.indexOf('## Session observations'), s.indexOf('## Linking'));
    fs.writeFileSync(routing, text.replace(section(text), section(predecessor['codex/ROUTING.md'])));
    const agents = path.join(home, 'AGENTS.md');
    const agentText = fs.readFileSync(agents, 'utf8');
    const line = (s: string) => s.split('\n').find(l => l.startsWith('- After a completed turn,'))!;
    fs.writeFileSync(agents, agentText.replace(line(agentText), line(predecessor['codex/AGENTS.maestro.md'])));
    fs.writeFileSync(path.join(home, 'hooks.state.json'), '{"synthetic":"preserve-trust"}');
    return { root, home, workspace, configFile, installOptions };
}
function snapshot(root: string) {
    const out: Record<string, string> = {};
    function walk(dir: string) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'backups')
                continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory())
                walk(p);
            else
                out[path.relative(root, p)] = fs.readFileSync(p).toString('base64');
        }
    }
    walk(root);
    return out;
}
function installIdentityPredecessor(f: ReturnType<typeof fixture>, previous = identityPredecessor) {
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    const config = fs.readFileSync(f.configFile, 'utf8');
    fs.writeFileSync(f.configFile, config.replaceAll(JSON.stringify(` \"--workspace-b64\" \"${Buffer.from(f.workspace).toString('base64url')}\"`).slice(1, -1), ''));
    const agentFile = path.join(f.home, 'agents', 'codex-obs.toml');
    const model = JSON.parse(/^model = (.*)$/m.exec(fs.readFileSync(agentFile, 'utf8'))![1]);
    fs.writeFileSync(agentFile, renderAgent('codex-obs', previous['codex/agents/codex-obs.md'], { model, reasoning: 'low', sandbox: 'read-only' }));
    const relative = 'codex/hooks/kherep-maestro-context.mts', bytes = previous[relative] ?? fs.readFileSync(path.join(REPO, relative), 'utf8');
    fs.writeFileSync(path.join(f.home, 'hooks', path.basename(relative)), bytes);
    const restoreRoot = path.join(f.home, 'orchestra', 'observation-source');
    fs.writeFileSync(path.join(restoreRoot, relative), bytes);
    const manifestFile = path.join(restoreRoot, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest[relative] = observationHash(bytes);
    if (previous === pilotPredecessor) {
        const hookDir = path.join(f.home, 'hooks', 'kherep-maestro');
        for (const [from, file] of [
            ['modules/atl-jira-brokers/observation-candidate.mts', path.join(hookDir, 'obs-candidate-policy.mts')],
            ['modules/atl-jira-brokers/observation-candidate.mts', path.join(f.workspace, 'tools', 'observation-candidate.mts')],
            ['codex/hooks/observation-stop.mts', path.join(hookDir, 'codex-observation-stop.mts')],
            ['codex/hooks/observation-turn-completion.mts', path.join(hookDir, 'codex-observation-turn-completion.mts')],
        ]) {
            const old = scopedPredecessor[from];
            fs.writeFileSync(file, from.startsWith('codex/hooks/') ? renderObservationHook(old, f.workspace) : old);
            fs.writeFileSync(path.join(restoreRoot, from), old);
            manifest[from] = observationHash(old);
        }
        const routingFile = path.join(f.home, 'orchestra', 'ROUTING.md'), routing = fs.readFileSync(routingFile, 'utf8');
        const section = (text: string) => text.slice(text.indexOf('## Session observations'), text.indexOf('## Linking'));
        fs.writeFileSync(routingFile, routing.replace(section(routing), section(scopedPredecessor['codex/ROUTING.md'])));
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}
for (const [version, previous] of identityVersions) test(`exact ${version} native identity predecessor upgrades installed hook, snapshot and recovery source idempotently`, t => {
    const f = fixture(t);
    installIdentityPredecessor(f, previous);
    const before = snapshot(f.root);
    assert.equal(checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }).predecessorRecognized, true);
    const result = installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.equal(result.receipt.installedHashesMatch, true);
    assert.equal(result.receipt.contextWorkspaceBinding, 'installer-workspace');
    assert.deepEqual(result.receipt.changedContextDefinitions, ['UserPromptSubmit', 'SessionStart']);
    const installed = snapshot(f.root);
    for (const parts of [['home', 'hooks.state.json'], ['home', 'orchestra', 'parity-receipt.json'], ['home', 'orchestra', 'control-plane-source.json'], ['home', 'hooks', 'parity', 'capabilities.json']]) {
        const name = path.join(...parts);
        assert.ok(Object.hasOwn(before, name) && Object.hasOwn(installed, name), name);
        assert.equal(installed[name], before[name], name);
    }
    const relative = 'codex/hooks/kherep-maestro-context.mts', hookFile = path.join(f.home, 'hooks', path.basename(relative));
    const source = fs.readFileSync(path.join(REPO, relative), 'utf8');
    assert.equal(fs.readFileSync(hookFile, 'utf8'), source);
    assert.equal(observationSnapshot(f.home, relative)?.toString(), source);
    assert.equal(observationSource(f.home, relative)?.toString(), source);
    for (const turn_id of ['native-turn', undefined]) {
        const env = { ...process.env };
        delete env.KHEREP_WORKSPACE;
        const hook = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', hookFile, '--workspace-b64', Buffer.from(f.workspace).toString('base64url')], { encoding: 'utf8', env,
            input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: f.workspace, session_id: 'main-session', turn_id, prompt: 'PRIVATE_PROMPT_CANARY' }) });
        assert.equal(hook.status, 0, hook.stderr);
        assert.ok(hook.stdout.includes(turn_id ? '{"sessionId":"main-session","turnId":"native-turn"}' : 'OBS-ATTEMPT: failed missing-turn-identity detail=none publication=not-attempted created=none'));
        assert.doesNotMatch(hook.stdout, /PRIVATE_PROMPT_CANARY/);
    }
    const after = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
});
test('unknown immediate context drift refuses before any installation write', t => {
    const f = fixture(t);
    installIdentityPredecessor(f);
    fs.appendFileSync(path.join(f.home, 'hooks', 'kherep-maestro-context.mts'), '\n// UNKNOWN_IDENTITY_DRIFT\n');
    const before = snapshot(f.root);
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /hook-drift/);
    assert.deepEqual(snapshot(f.root), before);
});
test('scoped upgrade preserves opaque config, trust, pin and shared pointer and measures installed closure', t => {
    const f = fixture(t);
    const before = snapshot(f.root);
    const result = installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    for (const field of ['predecessorRecognized', 'installedHashesMatch', 'unrelatedConfigUnchanged', 'hookStateUnchanged', 'controlPlanePointerUnchanged', 'externalHookPositionsUnchanged', 'integritySourceMatches', 'pinUnchanged'] as const)
        assert.equal(result.receipt[field], true, field);
    assert.equal(result.receipt.sandbox, 'read-only');
    assert.equal(result.receipt.nativeToolDiscovery, 'UNKNOWN');
    const config = fs.readFileSync(f.configFile, 'utf8');
    assert.match(config, /enabled_tools = \["publish_observations","related_candidates"\]/);
    assert.match(config, /env_vars = \["KHEREP_ATL_CRED_FILE_CODEX"/);
    assert.match(config, /operator_fixture/);
    const after = snapshot(f.root);
    for (const name of ['home/hooks.state.json', 'home/orchestra/parity-receipt.json', 'home/orchestra/control-plane-source.json', 'home/hooks/parity/capabilities.json'])
        assert.equal(after[name], before[name], name);
    for (const from of OBSERVATION_SOURCES) {
        assert.equal(observationSnapshot(f.home, from)?.toString(), fs.readFileSync(path.join(REPO, from), 'utf8'));
        assert.equal(observationSource(f.home, from)?.toString(), observationSnapshot(f.home, from)?.toString());
    }
    assert.equal(observationSource(f.home, 'claude/hooks/commit-guard.mts'), null);
    for (const name of observationFiles(REPO))
        assert.equal(fs.readFileSync(path.join(f.workspace, 'tools', name), 'utf8'), fs.readFileSync(path.join(REPO, 'modules', 'atl-jira-brokers', name), 'utf8'));
    const rpc = spawnSync(process.execPath, [path.join(f.workspace, 'tools', 'observation-stdio.mts')], { env: { CODEX_HOME: f.home }, encoding: 'utf8', input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'publish_observations', arguments: { sessionId: 'synthetic', turnId: 'turn', observations: [] } } }) + '\n' });
    assert.equal(rpc.status, 0, rpc.stderr);
    assert.match(rpc.stdout, /OBS-RESULT: empty no-admissible-findings/);
    assert.doesNotMatch(rpc.stdout, /CANARY|credential|confluence\.json/);
});
for (const [version, previous] of identityVersions) test(`${version} rollback restores every original home and workspace file after an injected write failure`, t => {
    const f = fixture(t);
    installIdentityPredecessor(f, previous);
    const before = snapshot(f.root);
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: n => {
            if (n === 17)
                throw new Error('synthetic failure');
        } }), /rolled-back/);
    assert.deepEqual(snapshot(f.root), before);
});
for (const [version, previous] of identityVersions) test(`${version} unknown observer drift fails closed before modifying target files`, t => {
    const f = fixture(t);
    installIdentityPredecessor(f, previous);
    fs.appendFileSync(path.join(f.home, 'agents', 'codex-obs.toml'), '# unknown drift\n');
    const before = snapshot(f.root);
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /agent-drift/);
    assert.deepEqual(snapshot(f.root), before);
});
test('corrupt observation snapshot never falls back to the older shared source', t => {
    const f = fixture(t);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    fs.appendFileSync(path.join(f.home, 'orchestra', 'observation-source', 'codex', 'hooks', 'obs-result-check.mts'), '// corrupt');
    assert.throws(() => observationSource(f.home, 'codex/hooks/obs-result-check.mts'), /unverified/);
});
for (const removed of ['context', 'result'])
    test(`missing ${removed} wiring fails preflight without writes`, t => {
        const f = fixture(t);
        let config = fs.readFileSync(f.configFile, 'utf8');
        config = config.replace(removed === 'result' ? 'codex-obs-result-check.mts' : 'kherep-maestro-context.mts', 'unrelated-synthetic.mts');
        fs.writeFileSync(f.configFile, config);
        const before = snapshot(f.root);
        assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /wiring-drift/);
        assert.deepEqual(snapshot(f.root), before);
    });
test('equivalent quoted observation table declarations fail before writing', t => {
    const f = fixture(t);
    fs.appendFileSync(f.configFile, '\n[mcp_servers."kherep_observations"]\ncommand = "foreign"\n');
    const before = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /table-drift/);
    assert.deepEqual(snapshot(f.root), before);
});
for (const messaging of [false, true])
    test(`scoped upgrade then full install recognizes canonical table position, messaging=${messaging}`, t => {
        const f = fixture(t, messaging);
        installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
        const before = fs.readFileSync(f.configFile, 'utf8');
        install(f.installOptions);
        assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
    });
test('known b9f5ef72 stdio predecessor upgrades and an idempotent rerun preserves installed bytes', t => {
    const f = fixture(t);
    const relative = 'modules/atl-jira-brokers/observation-stdio.mts';
    const entry = path.join(f.workspace, 'tools', 'observation-stdio.mts');
    fs.writeFileSync(entry, predecessor[relative]);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.equal(fs.readFileSync(entry, 'utf8'), fs.readFileSync(path.join(REPO, relative), 'utf8'));
    const after = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
});
test('arbitrary stdio byte drift still refuses before any installation write', t => {
    const f = fixture(t);
    const entry = path.join(f.workspace, 'tools', 'observation-stdio.mts');
    fs.appendFileSync(entry, '\n// UNKNOWN_SYNTHETIC_DRIFT\n');
    const before = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /broker-drift/);
    assert.deepEqual(snapshot(f.root), before);
});
test('rollback restores known stdio predecessor after its replacement was actually written', t => {
    const f = fixture(t);
    const entry = path.join(f.workspace, 'tools', 'observation-stdio.mts');
    const previous = predecessor['modules/atl-jira-brokers/observation-stdio.mts'];
    fs.writeFileSync(entry, previous);
    const before = snapshot(f.root);
    let replaced = false;
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: () => {
        if (fs.readFileSync(entry, 'utf8') !== previous) {
            replaced = true;
            throw new Error('synthetic failure after stdio replacement');
        }
    } }), /rolled-back/);
    assert.equal(replaced, true);
    assert.deepEqual(snapshot(f.root), before);
});
test('known 6577d76 policy predecessor upgrades idempotently but arbitrary policy drift refuses', t => {
    const f = fixture(t);
    const relative = 'modules/atl-jira-brokers/observation-policy.mts';
    const entry = path.join(f.workspace, 'tools', 'observation-policy.mts');
    assert.equal(typeof predecessor[relative], 'string');
    fs.writeFileSync(entry, predecessor[relative]);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.equal(fs.readFileSync(entry, 'utf8'), fs.readFileSync(path.join(REPO, relative), 'utf8'));
    const after = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
    fs.appendFileSync(entry, '\n// UNKNOWN_SYNTHETIC_POLICY_DRIFT\n');
    const drifted = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /broker-drift/);
    assert.deepEqual(snapshot(f.root), drifted);
});
const lookupPredecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-lookup-predecessor.json'), 'utf8')) as Record<string, string>;
const headerPredecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-header-predecessor.json'), 'utf8')) as Record<string, string>;
const prosePredecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-prose-predecessor.json'), 'utf8')) as Record<string, string>;
function installLookupPredecessor(f: ReturnType<typeof fixture>, previous: Record<string, string>) {
    if (previous === lookupPredecessor) fs.rmSync(path.join(f.workspace, 'tools', 'observation-lookup.mts'));
    for (const [relative, bytes] of Object.entries(previous)) {
        const file = relative.startsWith('modules/') ? path.join(f.workspace, 'tools', path.basename(relative))
            : path.join(f.home, 'hooks', 'kherep-maestro', path.basename(relative));
        fs.writeFileSync(file, bytes);
    }
    if (previous === lookupPredecessor) fs.writeFileSync(path.join(f.home, 'hooks', 'kherep-maestro', 'obs-result-policy.mts'), previous['modules/atl-jira-brokers/observation-result.mts']);
}
for (const [version, previous] of [['1532', lookupPredecessor], ['e13', headerPredecessor], ['b2d23faa', prosePredecessor]] as const) {
test(`exact ${version} predecessor upgrades both receipt policy copies, closure and snapshot`, t => {
    const f = fixture(t);
    installLookupPredecessor(f, previous);
    if (previous === prosePredecessor) {
        const relative = 'modules/atl-jira-brokers/observation-broker.mts';
        assert.deepEqual(Object.keys(previous), [relative]);
        const entry = path.join(f.workspace, 'tools', 'observation-broker.mts');
        fs.appendFileSync(entry, '\n// UNKNOWN_B2_BROKER_DRIFT\n');
        const drifted = snapshot(f.root);
        assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /broker-drift/);
        assert.deepEqual(snapshot(f.root), drifted);
        fs.writeFileSync(entry, previous[relative]);
    }
    const before = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    for (const name of ['home/hooks.state.json', 'home/orchestra/parity-receipt.json', 'home/orchestra/control-plane-source.json', 'home/hooks/parity/capabilities.json'])
        assert.equal(snapshot(f.root)[name], before[name], name);
    const helper = 'modules/atl-jira-brokers/observation-lookup.mts';
    assert.equal(observationSnapshot(f.home, helper)?.toString(), fs.readFileSync(path.join(REPO, helper), 'utf8'));
    for (const file of [path.join(f.workspace, 'tools', 'observation-result.mts'), path.join(f.home, 'hooks', 'kherep-maestro', 'obs-result-policy.mts')])
        assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(path.join(REPO, 'modules/atl-jira-brokers/observation-result.mts'), 'utf8'));
    const after = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
    const broker = path.join(f.workspace, 'tools', 'observation-broker.mts');
    fs.appendFileSync(broker, '\n// UNKNOWN_BROKER_DRIFT\n');
    const drifted = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /broker-drift/);
    assert.deepEqual(snapshot(f.root), drifted);
});
test(`${version} predecessor rollback preserves exact files and unknown helper drift refuses preflight`, t => {
    const f = fixture(t);
    installLookupPredecessor(f, previous);
    const before = snapshot(f.root);
    let replaced = false;
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: () => {
        if (fs.existsSync(path.join(f.workspace, 'tools', 'observation-lookup.mts'))
            && fs.readFileSync(path.join(f.workspace, 'tools', 'observation-broker.mts'), 'utf8') !== previous['modules/atl-jira-brokers/observation-broker.mts']) {
            replaced = true;
            throw new Error('synthetic failure after broker replacement');
        }
    } }), /rolled-back/);
    assert.equal(replaced, true);
    assert.deepEqual(snapshot(f.root), before);
    const helper = path.join(f.home, 'hooks', 'kherep-maestro', 'obs-result-policy.mts');
    fs.appendFileSync(helper, '\n// UNKNOWN_CANARY_DRIFT\n');
    const drift = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /helper-drift/);
    assert.deepEqual(snapshot(f.root), drift);
});
}

test('scoped context binding changes exactly the recognized command lines before full install', t => {
    const f = fixture(t);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    const bound = fs.readFileSync(f.configFile, 'utf8');
    const argument = JSON.stringify(` "--workspace-b64" "${Buffer.from(f.workspace).toString('base64url')}"`).slice(1, -1);
    const old = bound.replaceAll(argument, '');
    fs.writeFileSync(f.configFile, old);
    const result = installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.equal(fs.readFileSync(f.configFile, 'utf8'), bound);
    assert.equal(result.receipt.unrelatedConfigUnchanged, true);
    assert.deepEqual(result.receipt.changedContextDefinitions, ['UserPromptSubmit', 'SessionStart']);
    install(f.installOptions);
    assert.equal(fs.readFileSync(f.configFile, 'utf8'), bound);
});
for (const drift of ['foreign-workspace', 'mixed', 'command']) test(`scoped ${drift} binding refuses before writes`, t => {
    const f = fixture(t);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    let config = fs.readFileSync(f.configFile, 'utf8');
    const token = Buffer.from(f.workspace).toString('base64url');
    if (drift === 'foreign-workspace')
        config = config.replaceAll(token, Buffer.from(path.resolve('/foreign')).toString('base64url'));
    else if (drift === 'mixed')
        config = config.replace(JSON.stringify(` "--workspace-b64" "${token}"`).slice(1, -1), '');
    else
        config = config.replace('Loading Kherep Maestro', 'unknown drift');
    fs.writeFileSync(f.configFile, config);
    const before = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /context-wiring-drift/);
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /context-wiring-drift/);
    assert.deepEqual(snapshot(f.root), before);
});

test('failure after receipt write restores context config recovery and previous receipt together', t => {
    const f = fixture(t);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    const oldConfig = fs.readFileSync(f.configFile, 'utf8').replaceAll(JSON.stringify(` "--workspace-b64" "${Buffer.from(f.workspace).toString('base64url')}"`).slice(1, -1), '');
    fs.writeFileSync(f.configFile, oldConfig);
    const relative = 'codex/hooks/kherep-maestro-context.mts';
    const old = workspacePredecessor[relative];
    fs.writeFileSync(path.join(f.home, 'hooks', path.basename(relative)), old);
    const recovery = path.join(f.home, 'orchestra', 'observation-source');
    fs.writeFileSync(path.join(recovery, relative), old);
    const manifestFile = path.join(recovery, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest[relative] = observationHash(old);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const receiptFile = path.join(f.home, 'orchestra', 'observation-install-receipt.json');
    fs.writeFileSync(receiptFile, '{"synthetic":"old receipt"}');
    const before = snapshot(f.root);
    let reachedReceipt = false;
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: () => {
        if (fs.readFileSync(receiptFile, 'utf8') !== '{"synthetic":"old receipt"}') {
            reachedReceipt = true;
            assert.notEqual(fs.readFileSync(path.join(f.home, 'hooks', path.basename(relative)), 'utf8'), old);
            assert.match(fs.readFileSync(f.configFile, 'utf8'), /--workspace-b64/);
            throw new Error('synthetic post-receipt failure');
        }
    } }), /rolled-back/);
    assert.equal(reachedReceipt, true);
    assert.deepEqual(snapshot(f.root), before);
});

for (const location of ['before', 'between']) test(`publisher insertion stays active with messaging ${location} the context groups`, t => {
    const f = fixture(t, true);
    const old = fs.readFileSync(f.configFile, 'utf8');
    const messaging = scanDocument(old).tables.find(table => table.path.join('.') === 'mcp_servers.kherep_messaging')!;
    const end = Math.min(messaging.span.end, old.indexOf('# <<< Kherep Codex Maestro <<<'));
    const table = old.slice(messaging.span.start, end).trimEnd()
        + '\nsynthetic_note = """\n' + 'synthetic multiline content '.repeat(100) + '\n"""\n\n';
    const withoutMessaging = old.slice(0, messaging.span.start) + old.slice(end);
    const at = withoutMessaging.indexOf(location === 'before' ? '[[hooks.UserPromptSubmit]]' : '[[hooks.SessionStart]]');
    const before = withoutMessaging.slice(0, at) + table + withoutMessaging.slice(at);
    fs.writeFileSync(f.configFile, before);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    const after = fs.readFileSync(f.configFile, 'utf8');
    const tables = scanDocument(after).tables;
    const publishers = tables.filter(item => item.path.join('.') === 'mcp_servers.kherep_observations');
    assert.equal(publishers.length, 1, 'the publisher is an active structural table');
    const index = tables.indexOf(publishers[0]);
    assert.equal(tables[index + 1].path.join('.'), 'mcp_servers.kherep_messaging');
    assert.equal(after.slice(tables[index + 1].span.start, tables[index + 1].span.end), table);
    const publisher = renderObservationPublisher({ entry: path.join(f.workspace, 'tools', 'observation-stdio.mts'), home: f.home }, process.execPath);
    const argument = JSON.stringify(` "--workspace-b64" "${Buffer.from(f.workspace).toString('base64url')}"`).slice(1, -1);
    assert.equal(after.replace(`${publisher}\n\n`, '').replaceAll(argument, ''), before, 'all unrelated config bytes reconstruct exactly');
});
