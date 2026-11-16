// Issue #701: a home installed at 764200b upgrades through the observation-only updater
// although hook-integrity-sources.mts now registers the dispatch guard's worker-brief lib.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from './install.mts';
import { installObservationPublisher, checkObservationPublisher } from './install-observations.mts';
import { fixtureModelOptions, legacyModelHome } from './lib/model-policy.fixture.mts';
import { observationHash } from './lib/observation-source.mts';
const REPO = path.resolve(import.meta.dirname, '..');
const worker = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-worker-brief-predecessor.json'), 'utf8')) as Record<string, string>;
const source = (relative: string) => fs.readFileSync(path.join(REPO, relative), 'utf8');
const SOURCES = 'codex/hooks/hook-integrity-sources.mts';
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
/** A synthetic home whose hook-integrity-sources.mts and its snapshot hold exactly the 764200b bytes. */
function home764200b(t: { after(fn: () => void): void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-worker-brief-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    const registry = path.join(root, 'synthetic-registry.json');
    fs.writeFileSync(registry, '{"mcpServers":{}}', { mode: 0o600 });
    install({ ...fixtureModelOptions(), codexHome: home, workspace, claudeRegistryFile: registry, claudeConfigDir: path.join(root, 'empty-claude'),
        nodePath: process.execPath, skipPluginRegistration: true, resolveRegistryRuntime: () => ({}), log: () => { }, controlPlaneOutbox: path.join(root, 'outbox') });
    legacyModelHome(home);
    const file = path.join(home, 'hooks', 'kherep-maestro', 'hook-integrity-sources.mts');
    fs.writeFileSync(file, worker[SOURCES]);
    const snapshotRoot = path.join(home, 'orchestra', 'observation-source');
    const manifest = JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'manifest.json'), 'utf8')) as Record<string, string>;
    fs.writeFileSync(path.join(snapshotRoot, SOURCES), worker[SOURCES]);
    manifest[SOURCES] = observationHash(worker[SOURCES]);
    fs.writeFileSync(path.join(snapshotRoot, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(home, 'hooks.state.json'), '{"synthetic":"preserve-trust"}');
    return { root, home, workspace, file };
}
test('the predecessor holds exactly hook-integrity-sources.mts, which this change edits', () => {
    assert.deepEqual(Object.keys(worker), [SOURCES]);
    assert.notEqual(worker[SOURCES], source(SOURCES));
    assert.ok(!worker[SOURCES].includes('worker-brief-policy') && source(SOURCES).includes('worker-brief-policy'));
});
test('a 764200b home upgrades to exactly the new bytes, protected targets unchanged, idempotent rerun', t => {
    const f = home764200b(t);
    const before = snapshot(f.root);
    assert.equal(checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }).predecessorRecognized, true);
    const result = installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    for (const field of ['predecessorRecognized', 'installedHashesMatch', 'unrelatedConfigUnchanged', 'hookStateUnchanged', 'controlPlanePointerUnchanged', 'integritySourceMatches', 'pinUnchanged'] as const)
        assert.equal(result.receipt[field], true, field);
    assert.equal(fs.readFileSync(f.file, 'utf8'), source(SOURCES));
    assert.equal(fs.readFileSync(path.join(f.home, 'orchestra', 'observation-source', SOURCES), 'utf8'), source(SOURCES));
    const after = snapshot(f.root);
    for (const name of PROTECTED)
        assert.ok(before[name] !== undefined && after[name] === before[name], name);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
});
test('unknown hook-integrity-sources.mts bytes on a 764200b home refuse before any write', t => {
    const f = home764200b(t);
    fs.writeFileSync(f.file, `${worker[SOURCES]}\n// UNKNOWN_SYNTHETIC_DRIFT\n`);
    const before = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /hook-drift/);
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /hook-drift/);
    assert.deepEqual(snapshot(f.root), before);
});
