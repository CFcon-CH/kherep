// Issue #989: exact 132221d6 upgrade and drift refusal in generated homes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from './install.mts';
import { installObservationPublisher, checkObservationPublisher } from './install-observations.mts';
import { fixtureModelOptions, legacyModelHome } from './lib/model-policy.fixture.mts';
import { renderAgent } from './lib/component-render.mts';
import { observationHash, OBSERVATION_SOURCES } from './lib/observation-source.mts';
const REPO = path.resolve(import.meta.dirname, '..');
const old = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-link-reasons-predecessor.json'), 'utf8')) as Record<string, string>;
const source = (relative: string) => fs.readFileSync(path.join(REPO, relative), 'utf8');
const RESULT = 'modules/atl-jira-brokers/observation-result.mts';
const BROKERS = ['confluence-candidates', 'observation-linking', 'observation-policy', 'observation-publisher', 'observation-result', 'observation-stdio']
    .map(name => `modules/atl-jira-brokers/${name}.mts`);
function fixture(t: { after(fn: () => void): void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-link-reasons-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    const registry = path.join(root, 'synthetic-registry.json');
    fs.writeFileSync(registry, '{"mcpServers":{}}', { mode: 0o600 });
    install({ ...fixtureModelOptions(), codexHome: home, workspace, claudeRegistryFile: registry, claudeConfigDir: path.join(root, 'empty-claude'),
        nodePath: process.execPath, skipPluginRegistration: true, resolveRegistryRuntime: () => ({}), log: () => {}, controlPlaneOutbox: path.join(root, 'outbox') });
    legacyModelHome(home);
    const dir = path.join(home, 'hooks/kherep-maestro'), agent = path.join(home, 'agents/codex-obs.toml');
    const agentText = fs.readFileSync(agent, 'utf8');
    const agentOptions = { model: JSON.parse(/^model = (.*)$/m.exec(agentText)![1]), reasoning: JSON.parse(/^model_reasoning_effort = (.*)$/m.exec(agentText)![1]), sandbox: 'read-only' };
    const targets: Record<string, string> = {};
    for (const [relative, previous] of Object.entries(old)) {
        const file = relative === 'codex/agents/codex-obs.md' ? agent : path.join(workspace, 'tools', path.basename(relative));
        fs.writeFileSync(file, relative === 'codex/agents/codex-obs.md' ? renderAgent('codex-obs', previous, agentOptions) : previous);
        targets[relative] = file;
    }
    targets['installed-result-helper'] = path.join(dir, 'obs-result-policy.mts');
    fs.writeFileSync(targets['installed-result-helper'], old[RESULT]);
    targets['routing'] = path.join(home, 'orchestra/ROUTING.md');
    const snapshotRoot = path.join(home, 'orchestra/observation-source'), manifestFile = path.join(snapshotRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const relative of OBSERVATION_SOURCES) if (old[relative] !== undefined) {
        fs.writeFileSync(path.join(snapshotRoot, relative), old[relative]);
        manifest[relative] = observationHash(old[relative]);
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    return { home, workspace, targets, agentOptions };
}
test('the 132221d6 predecessor freezes exactly the changed observation files', () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    assert.deepEqual(Object.keys(old).sort(byName), ['codex/agents/codex-obs.md', ...BROKERS].sort(byName));
    for (const [relative, bytes] of Object.entries(old)) assert.notEqual(bytes, source(relative), relative);
});
test('the frozen 132221d6 generation upgrades to the current observation files and reruns idempotently', t => {
    const f = fixture(t);
    assert.equal(checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }).predecessorRecognized, true);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.equal(fs.readFileSync(f.targets['codex/agents/codex-obs.md'], 'utf8'), renderAgent('codex-obs', source('codex/agents/codex-obs.md'), f.agentOptions));
    for (const relative of BROKERS) assert.equal(fs.readFileSync(f.targets[relative], 'utf8'), source(relative), relative);
    assert.equal(fs.readFileSync(f.targets['installed-result-helper'], 'utf8'), source(RESULT));
    assert.equal(fs.readFileSync(path.join(f.home, 'orchestra/observation-source', RESULT), 'utf8'), source(RESULT));
    const after = fs.readFileSync(f.targets[BROKERS[1]], 'utf8');
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.equal(fs.readFileSync(f.targets[BROKERS[1]], 'utf8'), after);
});
for (const relative of [...Object.keys(old), 'installed-result-helper', 'routing'])
    test(`one-byte drift in 132221d6 ${relative} refuses`, t => {
        const f = fixture(t), file = f.targets[relative], text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, relative === 'routing' ? text.replace('## Session observations', '## Session observationX') : `${text}x`);
        const error = relative === 'installed-result-helper' ? /helper-drift/ : relative.startsWith('modules/') ? /broker-drift/
            : relative === 'codex/agents/codex-obs.md' ? /agent-drift/ : /predecessor-unrecognized/;
        assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), error);
    });
