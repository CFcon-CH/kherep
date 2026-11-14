// Issue #921: a tool approval table the Codex app wrote for kherep_observations
// is the operator's, not drift, for the observation-only updater and the installer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from './install.mts';
import { checkObservationPublisher } from './install-observations.mts';
import { fixtureModelOptions } from './lib/model-policy.fixture.mts';
const END = '# <<< Kherep Codex Maestro <<<';
const APPROVAL = '[mcp_servers.kherep_observations.tools.publish_observations]\napproval_mode = "approve"';
function generatedHome(t: { after(fn: () => void): void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-tool-approvals-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    const registry = path.join(root, 'synthetic-registry.json');
    fs.writeFileSync(registry, '{"mcpServers":{}}', { mode: 0o600 });
    const installOptions = { ...fixtureModelOptions(), codexHome: home, workspace, claudeRegistryFile: registry, claudeConfigDir: path.join(root, 'empty-claude'),
        nodePath: process.execPath, skipPluginRegistration: true, resolveRegistryRuntime: () => ({}), log: () => { }, controlPlaneOutbox: path.join(root, 'outbox') };
    install(installOptions);
    const configFile = path.join(home, 'config.toml'), installed = fs.readFileSync(configFile, 'utf8');
    assert.equal(installed.split('[mcp_servers.kherep_observations]').length, 2);
    const check = (config: string) => {
        fs.writeFileSync(configFile, config);
        return checkObservationPublisher({ codexHome: home, workspace });
    };
    return { configFile, installed, installOptions, check };
}
test('an approval table for kherep_observations is no drift inside or outside the block, and install lifts it', t => {
    const f = generatedHome(t);
    const inside = f.installed.replace(`\n${END}`, `\n\n${APPROVAL}\n${END}`);
    assert.notEqual(inside, f.installed);
    for (const config of [inside, `${f.installed}\n${APPROVAL}\n`, `${f.installed}\n[operator_after]\nkeep = 1\n\n${APPROVAL}\n`])
        assert.equal(f.check(config).unknownObservationDrift, false);
    fs.writeFileSync(f.configFile, inside);
    install(f.installOptions);
    const lifted = fs.readFileSync(f.configFile, 'utf8');
    assert.equal(lifted.slice(0, lifted.indexOf(END)), f.installed.slice(0, f.installed.indexOf(END)));
    assert.equal(lifted.split(APPROVAL).length, 2);
    assert.ok(lifted.slice(lifted.indexOf(END)).includes(`\n${APPROVAL}\n`));
    assert.equal(f.check(lifted).unknownObservationDrift, false);
});
test('any other kherep_observations subtable is still drift', t => {
    const f = generatedHome(t);
    for (const table of ['[mcp_servers.kherep_observations.env]\nCODEX_HOME = "synthetic"', `${APPROVAL}\nenabled = false`,
        '[mcp_servers.kherep_observations.tools]\napproval_mode = "approve"', `[${APPROVAL.replace(']', ']]')}`])
        assert.throws(() => f.check(`${f.installed}\n${table}\n`), /observation-tool-table-drift/, table);
});
