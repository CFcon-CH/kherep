import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

const repo = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const targets = [
  { name: 'Claude broker', file: 'modules/github-broker/github-claude.mts', exported: 'run' },
  { name: 'Codex broker', file: 'modules/github-broker/github-codex.mts', exported: 'run' },
  { name: 'projection', file: 'lib/github-broker-projection.mts', exported: 'githubBrokerFiles' },
];
const closure = [
  'auth.mts', 'broker.mts', 'cli.mts', 'config.mts', 'contract.mts', 'issues.mts',
  'key-access.mts', 'receipt.mts', 'transport.mts', 'windows-access.mts',
  'github-claude.mts', 'github-codex.mts',
];

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'github-entrypoint-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, {
      cwd: root, env: { PATH: process.env.PATH }, input: 'not-json',
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    // Node releases that still mark type stripping experimental print this warning; any other stderr fails.
    const stderr = result.stderr.replace(/^\(node:\d+\) ExperimentalWarning: Type Stripping .*\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?/m, '');
    assert.equal(stderr, '');
    return result;
  };
  return { root, run };
}

for (const target of targets) {
  for (const mode of ['direct', 'symlink', 'preserve-symlinks-main'] as const) {
    test(`${target.name} starts through ${mode}`, t => {
      const f = fixture(t);
      let entry = path.join(repo, target.file);
      if (mode !== 'direct') {
        const link = path.join(f.root, 'source-link');
        try { fs.symlinkSync(repo, link, 'dir'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          t.skip('directory symlink creation refused with EPERM');
          return;
        }
        entry = path.join(link, target.file);
      }
      const args = [...(mode === 'preserve-symlinks-main' ? ['--preserve-symlinks-main'] : []), entry];
      const projection = target.exported === 'githubBrokerFiles';
      if (projection) args.push(repo);
      const result = f.run(args);
      assert.equal(result.status, projection ? 0 : 1);
      assert.equal(result.stdout, projection ? closure.join('\n') + '\n' : '{"ok":false,"error":"invalid-request"}\n');
    });
  }

  for (const control of ['absent', 'unrelated-existing', 'nonexistent'] as const) {
    test(`${target.name} stays import-only with ${control} argv`, t => {
      const f = fixture(t);
      const unrelated = path.join(f.root, 'unrelated.mjs');
      if (control === 'unrelated-existing') fs.writeFileSync(unrelated, '');
      const argv = control === 'absent' ? [process.execPath] : [process.execPath, unrelated];
      const harness = `process.argv = ${JSON.stringify(argv)};
        const loaded = await import(${JSON.stringify(pathToFileURL(path.join(repo, target.file)).href)});
        if (typeof loaded[${JSON.stringify(target.exported)}] !== 'function') throw new Error('missing-export');
        process.stdout.write('import-ok\\n');`;
      const result = f.run(['--input-type=module', '-e', harness]);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'import-ok\n');
    });
  }
}
