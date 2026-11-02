// Issue #730: exact 57c0c47 upgrade, drift refusal and rollback in generated homes.
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
import { observationHash, OBSERVATION_SOURCES } from './lib/observation-source.mts';
const REPO = path.resolve(import.meta.dirname, '..');
const old = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-handback-predecessor.json'), 'utf8')) as Record<string, string>;
const source = (relative: string) => fs.readFileSync(path.join(REPO, relative), 'utf8');
const section = (s: string) => s.slice(s.indexOf('## Session observations'), s.indexOf('## Linking'));
const line = (s: string) => s.split('\n').find(row => row.startsWith('- After a completed turn,'))!;
const hooks: Record<string, string> = { 'obs-result-check.mts': 'codex-obs-result-check.mts',
    'kherep-maestro-context.mts': '../kherep-maestro-context.mts', 'observation-stop.mts': 'codex-observation-stop.mts',
    'observation-turn-completion.mts': 'codex-observation-turn-completion.mts' };
function snapshot(root: string) {
    const rows: Record<string, string> = {};
    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'backups') continue;
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else rows[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
        }
    }
    walk(root);
    return rows;
}
function fixture(t: { after(fn: () => void): void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-handback-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    const registry = path.join(root, 'synthetic-registry.json');
    fs.writeFileSync(registry, '{"mcpServers":{}}', { mode: 0o600 });
    install({ ...fixtureModelOptions(), codexHome: home, workspace, claudeRegistryFile: registry, claudeConfigDir: path.join(root, 'empty-claude'),
        nodePath: process.execPath, skipPluginRegistration: true, resolveRegistryRuntime: () => ({}), log: () => {}, controlPlaneOutbox: path.join(root, 'outbox') });
    const dir = path.join(home, 'hooks/kherep-maestro');
    const agent = path.join(home, 'agents/codex-obs.toml');
    const model = JSON.parse(/^model = (.*)$/m.exec(fs.readFileSync(agent, 'utf8'))![1]);
    const agentOptions = { model, reasoning: 'low', sandbox: 'read-only' };
    const targets: Record<string, string> = {};
    for (const [relative, previous] of Object.entries(old)) {
        let file: string, text = previous;
        if (relative === 'codex/agents/codex-obs.md') { file = agent; text = renderAgent('codex-obs', previous, agentOptions); }
        else if (relative.startsWith('codex/hooks/')) {
            const name = path.basename(relative);
            file = path.resolve(dir, hooks[name]);
            if (name.startsWith('observation-')) text = renderObservationHook(previous, workspace);
        } else if (relative === 'codex/AGENTS.maestro.md') {
            file = path.join(home, 'AGENTS.md');
            text = fs.readFileSync(file, 'utf8').replace(line(source(relative)), line(previous));
        } else if (relative === 'codex/ROUTING.md') {
            file = path.join(home, 'orchestra/ROUTING.md');
            text = fs.readFileSync(file, 'utf8').replace(section(source(relative)), section(previous));
        } else file = path.join(workspace, 'tools', path.basename(relative));
        fs.writeFileSync(file, text);
        targets[relative] = file;
    }
    const result = 'modules/atl-jira-brokers/observation-result.mts';
    const helper = path.join(dir, 'obs-result-policy.mts');
    fs.writeFileSync(helper, old[result]);
    targets['installed-result-helper'] = helper;
    const snapshotRoot = path.join(home, 'orchestra/observation-source');
    const manifestFile = path.join(snapshotRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const relative of OBSERVATION_SOURCES) if (old[relative] !== undefined) {
        fs.writeFileSync(path.join(snapshotRoot, relative), old[relative]);
        manifest[relative] = observationHash(old[relative]);
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    fs.writeFileSync(path.join(home, 'hooks.state.json'), '{"synthetic":"preserve-trust"}');
    return { root, home, workspace, targets, agentOptions };
}
test('the exact predecessor covers only changed projected bytes', () => {
    assert.deepEqual(Object.keys(old).sort(), ['codex/agents/codex-obs.md', ...Object.keys(hooks).map(name => `codex/hooks/${name}`),
        'codex/ROUTING.md', 'codex/AGENTS.maestro.md', 'modules/atl-jira-brokers/observation-result.mts',
        'modules/atl-jira-brokers/observation-stdio.mts', 'modules/atl-jira-brokers/confluence-neighbours.mts'].sort());
    for (const [relative, bytes] of Object.entries(old)) assert.notEqual(bytes, source(relative), relative);
});
test('the frozen 57c0c47 generation upgrades exactly, preserves protected files, and reruns idempotently', t => {
    const f = fixture(t), before = snapshot(f.root);
    assert.equal(checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }).predecessorRecognized, true);
    const installed = installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    for (const key of ['installedHashesMatch', 'hookStateUnchanged', 'controlPlanePointerUnchanged', 'integritySourceMatches', 'pinUnchanged'] as const)
        assert.equal(installed.receipt[key], true, key);
    assert.equal(fs.readFileSync(f.targets['codex/agents/codex-obs.md'], 'utf8'), renderAgent('codex-obs', source('codex/agents/codex-obs.md'), f.agentOptions));
    for (const name of Object.keys(hooks)) {
        const relative = `codex/hooks/${name}`;
        const expected = name.startsWith('observation-') ? renderObservationHook(source(relative), f.workspace) : source(relative);
        assert.equal(fs.readFileSync(f.targets[relative], 'utf8'), expected, relative);
    }
    for (const relative of Object.keys(old).filter(p => p.startsWith('modules/')))
        assert.equal(fs.readFileSync(f.targets[relative], 'utf8'), source(relative));
    assert.equal(fs.readFileSync(f.targets['installed-result-helper'], 'utf8'), source('modules/atl-jira-brokers/observation-result.mts'));
    assert.ok(fs.readFileSync(f.targets['codex/ROUTING.md'], 'utf8').includes(section(source('codex/ROUTING.md'))));
    assert.ok(fs.readFileSync(f.targets['codex/AGENTS.maestro.md'], 'utf8').includes(line(source('codex/AGENTS.maestro.md'))));
    for (const relative of OBSERVATION_SOURCES)
        assert.equal(fs.readFileSync(path.join(f.home, 'orchestra/observation-source', relative), 'utf8'), source(relative));
    for (const name of ['home/hooks.state.json', 'home/orchestra/parity-receipt.json', 'home/orchestra/control-plane-source.json', 'home/hooks/parity/capabilities.json'])
        assert.equal(snapshot(f.root)[path.normalize(name)], before[path.normalize(name)], name);
    const after = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
});
for (const relative of [...Object.keys(old), 'installed-result-helper'])
    test(`one-byte drift in 57c0c47 ${relative} refuses before writes`, t => {
        const f = fixture(t), file = f.targets[relative];
        const text = fs.readFileSync(file, 'utf8');
        const next = relative === 'codex/ROUTING.md' ? text.replace('## Session observations', '## Session observationX')
            : relative === 'codex/AGENTS.maestro.md' ? text.replace('After a completed turn,', 'After a completed turnX,') : text + 'x';
        fs.writeFileSync(file, next);
        const before = snapshot(f.root);
        const error = relative === 'installed-result-helper' ? /helper-drift/ : relative.startsWith('modules/') ? /broker-drift/
            : relative.startsWith('codex/hooks/') ? /hook-drift/ : relative === 'codex/agents/codex-obs.md' ? /agent-drift/ : /predecessor-unrecognized/;
        assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), error);
        assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace }), error);
        assert.deepEqual(snapshot(f.root), before);
    });
test('rollback after replacing the predecessor broker restores the exact prior bytes', t => {
    const f = fixture(t), before = snapshot(f.root);
    let replaced = false;
    const file = f.targets['modules/atl-jira-brokers/observation-stdio.mts'];
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: () => {
        if (fs.readFileSync(file, 'utf8') !== old['modules/atl-jira-brokers/observation-stdio.mts']) {
            replaced = true;
            throw new Error('synthetic rollback after replacement');
        }
    } }), /rolled-back/);
    assert.equal(replaced, true);
    assert.deepEqual(snapshot(f.root), before);
});
