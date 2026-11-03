// Issue #693: a home installed at f0893d7 upgrades through the observation-only updater.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from './install.mts';
import { installObservationPublisher, checkObservationPublisher } from './install-observations.mts';
import { fixtureModelOptions } from './lib/model-policy.fixture.mts';
import { renderAgent } from './lib/component-render.mts';
import { renderObservationHook } from './lib/observation-projection.mts';
import { observationHash } from './lib/observation-source.mts';
const REPO = path.resolve(import.meta.dirname, '..');
const scoped = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-scoped-revision-predecessor.json'), 'utf8')) as Record<string, string>;
const source = (relative: string) => fs.readFileSync(path.join(REPO, relative), 'utf8');
const section = (s: string) => s.slice(s.indexOf('## Session observations'), s.indexOf('## Linking'));
const AGENT = 'codex/agents/codex-obs.md', ROUTING = 'codex/ROUTING.md', CANDIDATE = 'modules/atl-jira-brokers/observation-candidate.mts';
const HOOKS: Record<string, string> = { 'codex/hooks/observation-stop.mts': 'codex-observation-stop.mts',
    'codex/hooks/observation-turn-completion.mts': 'codex-observation-turn-completion.mts' };
const PROTECTED = ['home/hooks.state.json', 'home/orchestra/parity-receipt.json', 'home/orchestra/control-plane-source.json', 'home/hooks/parity/capabilities.json'];
function snapshot(root: string) {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.name !== 'backups')
                e.isDirectory() ? walk(p) : out[path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
        }
    };
    walk(root);
    return out;
}
/** A synthetic home whose observation-managed files hold exactly the f0893d7 bytes. */
function f0893dHome(t: { after(fn: () => void): void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-scoped-revision-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    const registry = path.join(root, 'synthetic-registry.json');
    fs.writeFileSync(registry, '{"mcpServers":{}}', { mode: 0o600 });
    install({ ...fixtureModelOptions(), codexHome: home, workspace, claudeRegistryFile: registry, claudeConfigDir: path.join(root, 'empty-claude'),
        nodePath: process.execPath, skipPluginRegistration: true, resolveRegistryRuntime: () => ({}), log: () => { }, controlPlaneOutbox: path.join(root, 'outbox') });
    const hookDir = path.join(home, 'hooks', 'kherep-maestro');
    const files = { agent: path.join(home, 'agents', 'codex-obs.toml'), routing: path.join(home, 'orchestra', 'ROUTING.md'),
        helper: path.join(hookDir, 'obs-candidate-policy.mts'), broker: path.join(workspace, 'tools', 'observation-candidate.mts'),
        stop: path.join(hookDir, HOOKS['codex/hooks/observation-stop.mts']), turn: path.join(hookDir, HOOKS['codex/hooks/observation-turn-completion.mts']) };
    const model = JSON.parse(/^model = (.*)$/m.exec(fs.readFileSync(files.agent, 'utf8'))![1]);
    const reasoning = JSON.parse(/^model_reasoning_effort = (.*)$/m.exec(fs.readFileSync(files.agent, 'utf8'))![1]);
    const agentOptions = { model, reasoning, sandbox: 'read-only' };
    fs.writeFileSync(files.agent, renderAgent('codex-obs', scoped[AGENT], agentOptions));
    for (const [relative, target] of Object.entries(HOOKS))
        fs.writeFileSync(path.join(hookDir, target), renderObservationHook(scoped[relative], workspace));
    fs.writeFileSync(files.helper, scoped[CANDIDATE]);
    fs.writeFileSync(files.broker, scoped[CANDIDATE]);
    const routing = fs.readFileSync(files.routing, 'utf8');
    fs.writeFileSync(files.routing, routing.replace(section(routing), section(scoped[ROUTING])));
    const snapshotRoot = path.join(home, 'orchestra', 'observation-source');
    const manifest = JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'manifest.json'), 'utf8')) as Record<string, string>;
    for (const relative of [...Object.keys(HOOKS), CANDIDATE]) {
        fs.writeFileSync(path.join(snapshotRoot, relative), scoped[relative]);
        manifest[relative] = observationHash(scoped[relative]);
    }
    fs.writeFileSync(path.join(snapshotRoot, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(home, 'hooks.state.json'), '{"synthetic":"preserve-trust"}');
    return { root, home, workspace, files, agentOptions, routing };
}
test('the predecessor holds exactly the projected files this branch changes', () => {
    assert.deepEqual(Object.keys(scoped).sort(), [AGENT, ROUTING, ...Object.keys(HOOKS), CANDIDATE].sort());
    for (const [relative, bytes] of Object.entries(scoped))
        assert.notEqual(bytes, source(relative), relative);
});
test('an f0893d7 home upgrades to exactly the new bytes, protected targets unchanged, idempotent rerun', t => {
    const f = f0893dHome(t);
    const before = snapshot(f.root);
    assert.equal(checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }).predecessorRecognized, true);
    const result = installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    for (const field of ['predecessorRecognized', 'installedHashesMatch', 'unrelatedConfigUnchanged', 'hookStateUnchanged', 'controlPlanePointerUnchanged', 'integritySourceMatches', 'pinUnchanged'] as const)
        assert.equal(result.receipt[field], true, field);
    const read = (file: string) => fs.readFileSync(file, 'utf8');
    assert.equal(read(f.files.agent), renderAgent('codex-obs', source(AGENT), f.agentOptions));
    assert.equal(read(f.files.stop), renderObservationHook(source('codex/hooks/observation-stop.mts'), f.workspace));
    assert.equal(read(f.files.turn), renderObservationHook(source('codex/hooks/observation-turn-completion.mts'), f.workspace));
    assert.equal(read(f.files.helper), source(CANDIDATE));
    assert.equal(read(f.files.broker), source(CANDIDATE));
    assert.equal(read(f.files.routing), f.routing.replace(section(f.routing), section(source(ROUTING))));
    for (const relative of [...Object.keys(HOOKS), CANDIDATE])
        assert.equal(read(path.join(f.home, 'orchestra', 'observation-source', relative)), source(relative), relative);
    const after = snapshot(f.root);
    for (const name of PROTECTED)
        assert.ok(before[name] !== undefined && after[name] === before[name], name);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
});
const DRIFTS: [string, keyof ReturnType<typeof f0893dHome>['files'], RegExp][] = [['agent', 'agent', /agent-drift/],
    ['stop hook', 'stop', /hook-drift/], ['turn-completion hook', 'turn', /hook-drift/], ['candidate helper', 'helper', /helper-drift/],
    ['candidate broker', 'broker', /broker-drift/], ['routing section', 'routing', /predecessor-unrecognized/]];
for (const [label, key, error] of DRIFTS)
    test(`unknown ${label} bytes on an f0893d7 home refuse before any write`, t => {
        const f = f0893dHome(t);
        const file = f.files[key];
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, key === 'routing' ? text.replace('## Session observations', '## Session observations\nUNKNOWN_SYNTHETIC_DRIFT')
            : `${text}\n// UNKNOWN_SYNTHETIC_DRIFT\n`);
        const before = snapshot(f.root);
        assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), error);
        assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace }), error);
        assert.deepEqual(snapshot(f.root), before);
    });
test('rollback after the f0893d7 files were replaced restores the home byte-identically', t => {
    const f = f0893dHome(t);
    const before = snapshot(f.root);
    let replaced = false, agentReplaced = false;
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: () => {
        if (fs.readFileSync(f.files.broker, 'utf8') !== scoped[CANDIDATE]) {
            agentReplaced = fs.readFileSync(f.files.agent, 'utf8') === renderAgent('codex-obs', source(AGENT), f.agentOptions);
            replaced = true;
            throw new Error('synthetic failure after candidate replacement');
        }
    } }), /rolled-back/);
    assert.equal(replaced, true);
    assert.equal(agentReplaced, true);
    assert.deepEqual(snapshot(f.root), before);
});
