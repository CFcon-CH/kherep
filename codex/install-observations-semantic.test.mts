// Issue #1020: both earlier observation server tables (one tool and two tools,
// each with the five earlier env_vars) and the ba8cf9b9 broker bytes upgrade in
// place; a foreign table still refuses; rollback restores the exact prior state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { install } from './install.mts';
import { installObservationPublisher, checkObservationPublisher } from './install-observations.mts';
import { fixtureModelOptions, legacyModelHome } from './lib/model-policy.fixture.mts';
import { OBSERVATION_ENV_VARS, OBSERVATION_TOOLS, PREDECESSOR_OBSERVATION_ENV_VARS, PREDECESSOR_OBSERVATION_TOOLS,
    renderObservationPublisher } from './lib/observation-projection.mts';
const REPO = path.resolve(import.meta.dirname, '..');
const BASE = 'ba8cf9b9f40bb0c8ff9c5cd636d085db416d17e4';
const old = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-semantic-backend-predecessor.json'), 'utf8')) as Record<string, string>;
const source = (relative: string) => fs.readFileSync(path.join(REPO, relative), 'utf8');
function snapshot(root: string) {
    const rows: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'backups') continue;
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else rows[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
        }
    };
    walk(root);
    return rows;
}
function fixture(t: { after(fn: () => void): void }, tools: readonly string[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-semantic-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    const registry = path.join(root, 'synthetic-registry.json');
    fs.writeFileSync(registry, '{"mcpServers":{}}', { mode: 0o600 });
    install({ ...fixtureModelOptions(), codexHome: home, workspace, claudeRegistryFile: registry, claudeConfigDir: path.join(root, 'empty-claude'),
        nodePath: process.execPath, skipPluginRegistration: true, resolveRegistryRuntime: () => ({}), log: () => {}, controlPlaneOutbox: path.join(root, 'outbox') });
    legacyModelHome(home);
    // The ba8cf9b9 broker bytes of every closure file this change touches; files new in #1020 did not exist then.
    for (const [relative, bytes] of Object.entries(old)) fs.writeFileSync(path.join(workspace, 'tools', path.basename(relative)), bytes);
    const config = path.join(home, 'config.toml'), entry = { entry: path.join(workspace, 'tools', 'observation-stdio.mts'), home };
    const text = fs.readFileSync(config, 'utf8'), current = renderObservationPublisher(entry, process.execPath);
    assert.equal(text.split(current).length, 2);
    fs.writeFileSync(config, text.replace(current, renderObservationPublisher(entry, process.execPath, tools, PREDECESSOR_OBSERVATION_ENV_VARS)));
    return { root, home, workspace, config };
}
test('the env_vars change adds exactly the semantic backend variables', () => {
    assert.deepEqual(PREDECESSOR_OBSERVATION_ENV_VARS, ['KHEREP_ATL_CRED_FILE_CODEX', 'KHEREP_ATL_SITE', 'KHEREP_PROFILE', 'KHEREP_TWG_BIN', 'NODE_EXTRA_CA_CERTS']);
    assert.deepEqual(OBSERVATION_ENV_VARS, [...PREDECESSOR_OBSERVATION_ENV_VARS, 'KHEREP_SEMANTIC_BACKEND', 'KHEREP_CODEX_BIN']);
    const entry = { entry: 'e', home: 'h' };
    assert.ok(renderObservationPublisher(entry, 'n', OBSERVATION_TOOLS, PREDECESSOR_OBSERVATION_ENV_VARS)
        .endsWith('env_vars = ["KHEREP_ATL_CRED_FILE_CODEX", "KHEREP_ATL_SITE", "KHEREP_PROFILE", "KHEREP_TWG_BIN", "NODE_EXTRA_CA_CERTS"]'),
    'the predecessor rendering keeps the exact ba8cf9b9 literal');
});
test('the predecessor holds exactly the changed closure files with bytes that differ from the source', () => {
    for (const [relative, bytes] of Object.entries(old)) {
        assert.match(relative, /^modules\/atl-jira-brokers\/[a-z-]+\.mts$/);
        assert.notEqual(bytes, source(relative), relative);
    }
});
for (const [label, tools] of [['two-tool (ba8cf9b9)', OBSERVATION_TOOLS], ['one-tool', PREDECESSOR_OBSERVATION_TOOLS]] as const) {
    test(`the ${label} table with the earlier env_vars upgrades in place, idempotently`, t => {
        const f = fixture(t, tools);
        assert.equal(checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }).predecessorRecognized, true);
        installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
        const config = fs.readFileSync(f.config, 'utf8');
        const entry = { entry: path.join(f.workspace, 'tools', 'observation-stdio.mts'), home: f.home };
        assert.equal(config.split(renderObservationPublisher(entry, process.execPath)).length, 2);
        assert.ok(config.includes('"KHEREP_SEMANTIC_BACKEND", "KHEREP_CODEX_BIN"]'));
        for (const relative of Object.keys(old)) assert.equal(fs.readFileSync(path.join(f.workspace, 'tools', path.basename(relative)), 'utf8'), source(relative));
        const after = snapshot(f.root);
        installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
        assert.deepEqual(snapshot(f.root), after);
    });
    test(`rollback from the ${label} table restores the exact previous table and files`, t => {
        const f = fixture(t, tools), before = snapshot(f.root);
        assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: () => {
            throw new Error('synthetic rollback after the first write');
        } }), /rolled-back/);
        assert.deepEqual(snapshot(f.root), before);
    });
}
// The ba8cf9b9 state is installed live, so that upgrade path must be complete:
// every closure file of ba8cf9b9 that changed since must carry its exact bytes.
const git = (...args: string[]) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const hasGit = (() => { try { git('cat-file', '-e', `${BASE}^{commit}`); return true; } catch { return false; } })();
test('the ba8cf9b9 predecessor is byte-exact and covers every closure file changed since', { skip: !hasGit && 'no git history' }, () => {
    const closure = new Set<string>(), queue = ['observation-stdio.mts'];
    while (queue.length) {
        const name = queue.shift()!;
        if (closure.has(name)) continue;
        closure.add(name);
        for (const [, spec] of git('show', `${BASE}:modules/atl-jira-brokers/${name}`).matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+\.mts)['"]/g)) queue.push(spec);
    }
    const changed = new Set(git('diff', '--name-only', BASE, 'HEAD').split('\n').filter(Boolean));
    const expected = [...closure].map(name => `modules/atl-jira-brokers/${name}`).filter(relative => changed.has(relative)).sort();
    assert.deepEqual(Object.keys(old).sort(), expected);
    for (const [relative, bytes] of Object.entries(old)) assert.equal(bytes, git('show', `${BASE}:${relative}`), relative);
});
test('a foreign table still refuses before writes', t => {
    const f = fixture(t, OBSERVATION_TOOLS);
    fs.writeFileSync(f.config, fs.readFileSync(f.config, 'utf8').replace('"NODE_EXTRA_CA_CERTS"]', '"NODE_EXTRA_CA_CERTS", "OTHER"]'));
    const before = snapshot(f.root);
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /observation-tool-table-drift/);
    assert.deepEqual(snapshot(f.root), before);
});
test('a closure file that matches neither source nor a predecessor still refuses', t => {
    const f = fixture(t, OBSERVATION_TOOLS);
    const file = path.join(f.workspace, 'tools', 'confluence-semantic.mts');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}x`);
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /observation-broker-drift/);
});
