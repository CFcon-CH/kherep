import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { declareCopy } from './coverage-copy-fixture.mts';
import test from 'node:test';
import { auditRepository } from './publication-audit.mts';

function fixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  return root;
}

test('checks case-insensitive terms in names and contents without echoing matches', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'AcmeLegacy.md'), 'acmeLEGACY contact');
  const report = auditRepository(root, ['acmelegacy']);
  assert.equal(report.files, 1);
  assert.deepEqual(report.issues.map((issue) => issue.category), ['forbidden-path', 'forbidden-content']);
  assert.doesNotMatch(JSON.stringify(report), /acmelegacy/i);
});

test('includes ignored files when tracked, but excludes untracked local settings', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'local.json\n');
  fs.writeFileSync(path.join(root, 'local.json'), 'LegacyBrand');
  assert.equal(auditRepository(root, ['legacybrand']).issues.length, 0);
  execFileSync('git', ['-C', root, 'add', '--force', 'local.json']);
  assert.equal(auditRepository(root, ['legacybrand']).issues.length, 1);
});

test('reports private payload categories without printing values', (t) => {
  const root = fixture(t);
  const email = 'operator' + '@' + 'nonreserved-domain.com';
  const endpoint = ['https://service', 'local/'].join('.');
  const keyMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  fs.writeFileSync(path.join(root, 'example.txt'), `${email}\n${endpoint}\n${keyMarker}`);
  const report = auditRepository(root, []);
  assert.deepEqual(report.issues.map((issue) => issue.category), ['email-review', 'private-endpoint', 'secret-marker']);
  assert.doesNotMatch(JSON.stringify(report), /operator|nonreserved|service\.local|BEGIN/);
});

test('accepts reserved documentation addresses and loopback', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'example.md'), 'user@example.com user@example.org https://service.example.invalid http://127.0.0.1:8080');
  assert.deepEqual(auditRepository(root, []).issues, []);
});

test('a missing tracked file is a review finding, not an unexamined clean result', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'missing.md'), 'text');
  execFileSync('git', ['-C', root, 'add', 'missing.md']);
  fs.unlinkSync(path.join(root, 'missing.md'));
  assert.ok(auditRepository(root, []).issues.some((issue) => issue.category === 'unreadable'));
});

test('does not follow a symlink to content outside the repository', (t) => {
  const root = fixture(t);
  const outside = path.join(os.tmpdir(), `publication-external-${process.pid}.txt`);
  fs.writeFileSync(outside, 'sentinel');
  t.after(() => fs.rmSync(outside, { force: true }));
  try { fs.symlinkSync(outside, path.join(root, 'linked.txt')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlink creation unavailable'); return; }
    throw error;
  }
  assert.equal(auditRepository(root, []).issues[0].category, 'non-regular-file');
});

test('CLI fails closed when the external publication policy is missing', (t) => {
  const root = fixture(t);
  assert.throws(() => execFileSync(process.execPath, [
    path.join(import.meta.dirname, 'publication-audit.mts'), root,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), (error: unknown) => {
    assert.equal((error as { status: number }).status, 2);
    return true;
  });
});

test('a linked parent directory cannot expose an external file', (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const folder = path.join(root, 'directory');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'tracked.md'), 'original');
  execFileSync('git', ['-C', root, 'add', 'directory/tracked.md']);
  fs.unlinkSync(path.join(folder, 'tracked.md'));
  fs.rmdirSync(folder);
  fs.writeFileSync(path.join(outside, 'tracked.md'), 'external-sentinel');
  fs.symlinkSync(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
  const report = auditRepository(root, ['external-sentinel']);
  assert.ok(report.issues.some((issue) => issue.category === 'escaping-path'));
  assert.ok(report.issues.every((issue) => issue.category !== 'forbidden-content'));
});

test('fails closed when clean working-tree bytes hide forbidden staged bytes', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'candidate.md'), 'LegacyBrand');
  execFileSync('git', ['-C', root, 'add', 'candidate.md']);
  fs.writeFileSync(path.join(root, 'candidate.md'), 'clean candidate');
  assert.ok(auditRepository(root, ['legacybrand']).issues.some((issue) => issue.category === 'forbidden-content'));
});

test('redacts sensitive extension filenames in findings', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'customer-prod.pem'), 'fixture');
  const report = auditRepository(root, []);
  assert.ok(report.issues.some((issue) => issue.category === 'sensitive-path'));
  assert.doesNotMatch(JSON.stringify(report), /customer-prod/);
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`fails closed when ${flag} suppresses indexed comparisons`, (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'candidate.md'), 'LegacyBrand');
    execFileSync('git', ['-C', root, 'add', 'candidate.md']);
    execFileSync('git', ['-C', root, 'update-index', flag, 'candidate.md']);
    fs.writeFileSync(path.join(root, 'candidate.md'), 'clean candidate');
    assert.ok(auditRepository(root, ['legacybrand']).issues.some((issue) => issue.category === 'forbidden-content'));
  });
}

test('scans staged bytes even when working-tree size and mtime are unchanged', (t) => {
  const root=fixture(t);
  execFileSync('git',['-C',root,'config','core.trustctime','false']);
  execFileSync('git',['-C',root,'config','core.checkStat','minimal']);
  const file=path.join(root,'candidate.md');
  fs.writeFileSync(file,'LegacyBrand');
  const earlier=new Date(Date.now()-60000);
  fs.utimesSync(file,earlier,earlier);
  execFileSync('git',['-C',root,'add','candidate.md']);
  fs.writeFileSync(file,'clean text!');
  fs.utimesSync(file,earlier,earlier);
  assert.ok(auditRepository(root,['legacybrand']).issues.some((issue)=>issue.category==='forbidden-content'));
});


const reviewPath = 'bootstrap/publication-reviews.json';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const syntheticContact = ['author', 'upstream.example.edu'].join('@');
type Pair = { file: string; category: string };
type ReviewReport = { files: number; scanned: number; indexed: number; issues: Pair[]; reviewed?: Pair[]; complete?: boolean };
async function reviewedFixture(t: test.TestContext, bytes: string | Buffer = syntheticContact, records?: unknown) {
  const root = fixture(t), trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-trusted-'));
  t.after(() => fs.rmSync(trusted, { recursive: true, force: true }));
  const source = path.join(import.meta.dirname, 'publication-audit.mts'), scanner = path.join(trusted, 'bootstrap/publication-audit.mts');
  const helper = path.join(import.meta.dirname, '../claude/hooks/lib/trusted-executable.mts'), copied = path.join(trusted, 'claude/hooks/lib/trusted-executable.mts');
  fs.mkdirSync(path.dirname(scanner), { recursive: true }); fs.mkdirSync(path.dirname(copied), { recursive: true });
  fs.copyFileSync(source, scanner); declareCopy(source, scanner); fs.copyFileSync(helper, copied); declareCopy(helper, copied);
  const evidence = JSON.stringify(records ?? [['fixture.md', 'email-review', digest(bytes)]]);
  fs.writeFileSync(path.join(trusted, reviewPath), evidence); fs.mkdirSync(path.join(root, 'bootstrap'));
  fs.writeFileSync(path.join(root, reviewPath), evidence); fs.writeFileSync(path.join(root, 'fixture.md'), bytes);
  execFileSync('git', ['-C', root, 'add', '.']);
  const api = await import(pathToFileURL(scanner).href);
  const audit = (terms: string[] = []): ReviewReport => api.auditRepository(root, terms);
  const cli = (terms: string[] = ['synthetic-policy-term']) => {
    const policy = path.join(trusted, 'synthetic-policy.json'); fs.writeFileSync(policy, JSON.stringify(terms));
    return spawnSync(process.execPath, [scanner, root, policy], { encoding: 'utf8' });
  };
  return { root, trusted, scanner, audit, cli, evidence, write: (value: string | Buffer) => fs.writeFileSync(path.join(root, 'fixture.md'), value), stage: () => execFileSync('git', ['-C', root, 'add', '.']) };
}

test('exact reviewed bytes clear only the category and preserve full view counts through API and CLI', async t => {
  const f = await reviewedFixture(t); const report = f.audit();
  assert.deepEqual(report.issues, []); assert.deepEqual(report.reviewed, [{ file: 'fixture.md', category: 'email-review' }]);
  assert.deepEqual([report.files, report.scanned, report.indexed], [2, 2, 2]); assert.equal(report.complete, true);
  const cli = f.cli(); assert.equal(cli.status, 0); assert.deepEqual(JSON.parse(cli.stdout).reviewed, report.reviewed);
});

for (const variant of ['byte', 'crlf', 'clean', 'rename', 'copy', 'index-only', 'wt-only', 'no-index', 'same-size-mtime'] as const) {
  test(`review cannot subtract stale or mismatched ${variant} views`, async t => {
    const original = syntheticContact + '\n'; const f = await reviewedFixture(t, original);
    if (variant === 'rename') { fs.renameSync(path.join(f.root, 'fixture.md'), path.join(f.root, 'renamed.md')); f.stage(); }
    else if (variant === 'copy') fs.copyFileSync(path.join(f.root, 'fixture.md'), path.join(f.root, 'copy.md'));
    else if (variant === 'no-index') execFileSync('git', ['-C', f.root, 'rm', '--cached', 'fixture.md']);
    else {
      const changed = variant === 'crlf' ? original.replace('\n', '\r\n') : variant === 'clean' ? 'neutral documentation\n' : original.replace('author', 'writer');
      const stamp = fs.statSync(path.join(f.root, 'fixture.md'));
      f.write(changed);
      if (variant === 'index-only') { f.stage(); f.write(original); }
      else if (variant !== 'wt-only' && variant !== 'same-size-mtime') f.stage();
      if (variant === 'same-size-mtime') fs.utimesSync(path.join(f.root, 'fixture.md'), stamp.atime, stamp.mtime);
    }
    const report = f.audit();
    if (variant === 'copy') { assert.deepEqual(report.issues, [{ file: 'copy.md', category: 'email-review' }]); assert.equal(report.reviewed?.length, 1); }
    else { assert.ok(report.issues.some(x => x.category === 'stale-review')); assert.equal(report.reviewed?.length, 0); }
  });
}

test('reviewed binary still reports complete hard predicates behind NUL and after a policy change', async t => {
  const bytes = Buffer.from('opaque\0' + 'future-rule' + ['-----BEGIN', 'PRIVATE KEY-----'].join(' '));
  const f = await reviewedFixture(t, bytes, [['fixture.md', 'binary-review', digest(bytes)]]);
  const report = f.audit(['future-rule']);
  assert.ok(report.issues.some(x => x.category === 'forbidden-content')); assert.ok(report.issues.some(x => x.category === 'secret-marker'));
  assert.deepEqual(report.reviewed, [{ file: 'fixture.md', category: 'binary-review' }]);
  assert.doesNotMatch(JSON.stringify(report), /future-rule|BEGIN/);
});
test('new policy refuses unchanged reviewed binary bytes', async t => {
  const bytes = Buffer.from('opaque\0late-rule'); const f = await reviewedFixture(t, bytes, [['fixture.md', 'binary-review', digest(bytes)]]);
  assert.deepEqual(f.audit(['other-rule']).issues, []);
  assert.ok(f.audit(['late-rule']).issues.some(x => x.category === 'forbidden-content'));
});
test('reviewing an email never subtracts hard content or secret categories', async t => {
  const bytes = syntheticContact + ' hard-sentinel ' + ['-----BEGIN', 'PRIVATE KEY-----'].join(' '); const f = await reviewedFixture(t, bytes);
  const report = f.audit(['hard-sentinel']);
  assert.deepEqual(report.issues.map(x => x.category), ['forbidden-content', 'secret-marker']); assert.equal(report.reviewed?.length, 1);
});

const invalidRecords: [string, (hash: string) => unknown][] = [
 ['object', h => ({ path: 'fixture.md', category: 'email-review', sha256: h })],
 ['invalid-hash', _ => [['fixture.md', 'email-review', 'bad']]],
 ['uppercase-hash', h => [['fixture.md', 'email-review', h.toUpperCase()]]],
 ['duplicate', h => [['fixture.md', 'email-review', h], ['fixture.md', 'email-review', h]]],
 ['contradictory', h => [['fixture.md', 'email-review', h], ['fixture.md', 'private-endpoint', '0'.repeat(64)]]],
 ['hard-category', h => [['fixture.md', 'forbidden-content', h]]],
 ['secret-category', h => [['fixture.md', 'secret-marker', h]]],
 ['absolute', h => [['/outside.md', 'email-review', h]]],
 ['traversal', h => [['../outside.md', 'email-review', h]]],
 ['dot-segment', h => [['./fixture.md', 'email-review', h]]],
 ['empty-segment', h => [['folder//fixture.md', 'email-review', h]]],
 ['backslash', h => [['folder\\fixture.md', 'email-review', h]]],
 ['self', h => [[reviewPath, 'email-review', h]]],
];
for (const [name, records] of invalidRecords) test(`unusable review ${name} fails whole evidence closed with CLI2`, async t => {
  const f = await reviewedFixture(t, syntheticContact, records(digest(syntheticContact))); const report = f.audit();
  assert.equal(f.cli().status, 2); assert.ok(report.issues.some(x => x.category === 'email-review'));
  assert.equal(report.complete, false); assert.equal(report.reviewed?.length, 0);
});
for (const mode of ['foreign', 'only-staged', 'only-working-tree', 'missing-trusted', 'manifest-link', 'parent-link'] as const) test(`review evidence ${mode} cannot authorize any subtraction`, async t => {
  const f = await reviewedFixture(t);
  const file = path.join(f.root, reviewPath), trusted = path.join(f.trusted, reviewPath);
  if (mode === 'foreign') fs.writeFileSync(file, '[]');
  else if (mode === 'only-staged') fs.unlinkSync(file);
  else if (mode === 'only-working-tree') execFileSync('git', ['-C', f.root, 'rm', '--cached', reviewPath]);
  else if (mode === 'missing-trusted') fs.unlinkSync(trusted);
  else {
    fs.unlinkSync(file);
    if (mode === 'manifest-link') fs.symlinkSync(trusted, file);
    else { fs.rmdirSync(path.dirname(file)); fs.symlinkSync(path.dirname(trusted), path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir'); }
  }
  const report = f.audit(); assert.equal(f.cli().status, 2); assert.equal(report.complete, false); assert.equal(report.reviewed?.length, 0);
});
test('conflict index stages never become one reviewed Stage0 pair', async t => {
  const f = await reviewedFixture(t); const blob = execFileSync('git', ['-C', f.root, 'rev-parse', ':fixture.md'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', f.root, 'update-index', '--force-remove', 'fixture.md']);
  execFileSync('git', ['-C', f.root, 'update-index', '--index-info'], { input: `100644 ${blob} 1\tfixture.md\n100644 ${blob} 2\tfixture.md\n` });
  const report = f.audit(); assert.ok(report.issues.some(x => x.category === 'stale-review')); assert.equal(report.reviewed?.length, 0); assert.equal(report.indexed, 3);
});
test('changed category becomes stale rather than a blanket review', async t => {
  const f = await reviewedFixture(t, syntheticContact, [['fixture.md', 'private-endpoint', digest(syntheticContact)]]);
  const report = f.audit(); assert.ok(report.issues.some(x => x.category === 'email-review')); assert.ok(report.issues.some(x => x.category === 'stale-review')); assert.equal(report.reviewed?.length, 0);
});


test('ignored untracked evidence remains visible and cannot authorize subtraction', async t => {
  const f = await reviewedFixture(t); execFileSync('git', ['-C', f.root, 'rm', '--cached', reviewPath]);
  fs.writeFileSync(path.join(f.root, '.gitignore'), reviewPath + '\n');
  const report = f.audit(); assert.equal(f.cli().status, 2); assert.equal(report.complete, false);
  assert.ok(report.issues.some(x => x.category === 'email-review')); assert.equal(report.files, 3);
});
test('exact private endpoint evidence is category-bound too', async t => {
  const bytes = ['https://fixture', 'internal/'].join('.');
  const f = await reviewedFixture(t, bytes, [['fixture.md', 'private-endpoint', digest(bytes)]]);
  assert.deepEqual(f.audit().issues, []); assert.deepEqual(f.audit().reviewed, [{ file: 'fixture.md', category: 'private-endpoint' }]);
});
test('one invalid review prevents partial subtraction and preserves hard findings', async t => {
  const bytes = syntheticContact + ' hard-sentinel';
  const f = await reviewedFixture(t, bytes, [['fixture.md', 'email-review', digest(bytes)], ['../outside', 'email-review', digest(bytes)]]);
  const report = f.audit(['hard-sentinel']); assert.equal(report.complete, false); assert.equal(report.reviewed?.length, 0);
  assert.ok(report.issues.some(x => x.category === 'forbidden-content')); assert.ok(report.issues.some(x => x.category === 'email-review'));
});
test('review manifest itself is fully scanned and cannot review itself', async t => {
  const f = await reviewedFixture(t, syntheticContact, [['hard-sentinel.md', 'email-review', digest(syntheticContact)]]);
  const report = f.audit(['hard-sentinel']); assert.ok(report.issues.some(x => x.file === reviewPath && x.category === 'forbidden-content'));
  assert.ok(report.issues.some(x => x.category === 'stale-review'));
});
test('missing candidate is stale without opening any evidence-supplied file', async t => {
  const f = await reviewedFixture(t); fs.unlinkSync(path.join(f.root, 'fixture.md')); execFileSync('git', ['-C', f.root, 'update-index', '--force-remove', 'fixture.md']);
  const report = f.audit(); assert.ok(report.issues.some(x => x.category === 'stale-review')); assert.equal(report.reviewed?.length, 0);
});
test('linked candidate cannot match otherwise exact indexed evidence', async t => {
  const f = await reviewedFixture(t); const candidate = path.join(f.root, 'fixture.md'), outside = path.join(f.trusted, 'outside.md');
  fs.writeFileSync(outside, syntheticContact); fs.unlinkSync(candidate); fs.symlinkSync(outside, candidate);
  const report = f.audit(); assert.equal(report.complete, false); assert.equal(report.reviewed?.length, 0); assert.ok(report.issues.some(x => x.category === 'stale-review'));
});
test('conflicted manifest is unusable for every candidate', async t => {
  const f = await reviewedFixture(t); const blob = execFileSync('git', ['-C', f.root, 'rev-parse', ':' + reviewPath], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', f.root, 'update-index', '--force-remove', reviewPath]);
  execFileSync('git', ['-C', f.root, 'update-index', '--index-info'], { input: `100644 ${blob} 1\t${reviewPath}\n100644 ${blob} 2\t${reviewPath}\n` });
  const report = f.audit(); assert.equal(report.complete, false); assert.equal(report.reviewed?.length, 0); assert.equal(f.cli().status, 2);
});
test('malformed trusted JSON is generic CLI2 and no partial review', async t => {
  const f = await reviewedFixture(t); fs.writeFileSync(path.join(f.trusted, reviewPath), '{');
  fs.writeFileSync(path.join(f.root, reviewPath), '{'); f.stage();
  assert.equal(f.cli().status, 2); assert.equal(f.audit().reviewed?.length, 0);
});
test('missing trusted Git is redacted CLI2, never an unexamined pass', async t => {
  const f = await reviewedFixture(t); f.cli();
  const result = spawnSync(process.execPath, [f.scanner, f.root, path.join(f.trusted, 'synthetic-policy.json')], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'Publication audit could not complete; no clean result is available.');
});


test('orphan categories keep one deduplicated stale finding per path', async t => {
  const h = digest(syntheticContact); const f = await reviewedFixture(t, syntheticContact, [['missing.md', 'email-review', h], ['missing.md', 'private-endpoint', h]]);
  assert.equal(f.audit().issues.filter(x => x.file === 'missing.md' && x.category === 'stale-review').length, 1);
});


test('shipped product manifest authorizes its actual public file bytes through the Stage0 WT loader and CLI', async t => {
  const f = await reviewedFixture(t), stock = fs.readFileSync(new URL('./publication-reviews.json', import.meta.url));
  const records = JSON.parse(stock.toString('utf8')) as Array<[string, unknown, string]>;
  assert.equal(records.length, 20);
  fs.unlinkSync(path.join(f.root, 'fixture.md')); execFileSync('git', ['-C', f.root, 'update-index', '--force-remove', 'fixture.md']);
  for (const [name, , hash] of records) {
    assert.match(name, /^[A-Za-z0-9_.\/-]+$/); assert.ok(!name.split('/').includes('..'));
    const bytes = fs.readFileSync(new URL('../' + name, import.meta.url)); assert.equal(digest(bytes), hash);
    const target = path.join(f.root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  fs.writeFileSync(path.join(f.trusted, reviewPath), stock); fs.writeFileSync(path.join(f.root, reviewPath), stock); f.stage();
  const cli = f.cli(); assert.equal(cli.status, 0, 'the shipped catalog must be usable, not CLI2');
  const report = JSON.parse(cli.stdout) as ReviewReport; assert.equal(report.complete, true); assert.deepEqual(report.issues, []);
  assert.equal(report.reviewed?.length, records.length); assert.deepEqual([report.files, report.scanned, report.indexed], [21, 21, 21]);
  assert.deepEqual(f.audit().reviewed, report.reviewed);
});
for (const stage of [1, 2, 3]) test(`unreviewed harmless index Stage${stage} is incomplete CLI2`, t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'plain.md'), 'neutral documentation'); execFileSync('git', ['-C', root, 'add', 'plain.md']);
  const blob = execFileSync('git', ['-C', root, 'rev-parse', ':plain.md'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', root, 'update-index', '--force-remove', 'plain.md']);
  execFileSync('git', ['-C', root, 'update-index', '--index-info'], { input: `100644 ${blob} ${stage}\tplain.md\n` });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-conflict-policy-')); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const policy = path.join(outside, 'synthetic-policy.json'); fs.writeFileSync(policy, JSON.stringify(['synthetic-policy-term']));
  const cli = spawnSync(process.execPath, [path.join(import.meta.dirname, 'publication-audit.mts'), root, policy], { encoding: 'utf8' });
  assert.equal(cli.status, 2); const report = auditRepository(root, []); assert.equal(report.complete, false);
  assert.ok(report.issues.some(x => x.file === 'plain.md' && x.category === 'index-conflict')); assert.equal(report.indexed, 1); assert.equal(report.scanned, 1);
});
test('unreviewed conflict continues hard content classification in every view', t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'plain.md'), 'hard-sentinel'); execFileSync('git', ['-C', root, 'add', 'plain.md']);
  const blob = execFileSync('git', ['-C', root, 'rev-parse', ':plain.md'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', root, 'update-index', '--force-remove', 'plain.md']);
  execFileSync('git', ['-C', root, 'update-index', '--index-info'], { input: `100644 ${blob} 1\tplain.md\n100644 ${blob} 2\tplain.md\n100644 ${blob} 3\tplain.md\n` });
  const report = auditRepository(root, ['hard-sentinel']); assert.equal(report.complete, false);
  assert.ok(report.issues.some(x => x.category === 'forbidden-content')); assert.ok(report.issues.some(x => x.category === 'index-conflict')); assert.equal(report.indexed, 3);
});
