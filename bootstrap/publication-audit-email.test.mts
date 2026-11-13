// Issue #906. Address-shaped text is found by a scan anchored on each "@"
// instead of a backtracking expression. Every address is assembled at runtime,
// so this file itself carries no address-shaped text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { auditRepository } from './publication-audit.mts';

const at = (local: string, domain: string): string => `${local}@${domain}`;

function repository(t: test.TestContext, text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-audit-email-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  fs.writeFileSync(path.join(root, 'fixture.txt'), text);
  return root;
}
const categories = (t: test.TestContext, text: string): string[] =>
  auditRepository(repository(t, text), []).issues.map((issue) => issue.category);

test('an address with a non-reserved domain needs review', (t) => {
  // The second address of the second text starts at ".x": a local part never reaches back over the previous address.
  for (const text of [`x ${at('someone', 'corp.io')} y`, at(at('a', 'b.example.x'), 'corp.org'), at('A', 'B.CO1')]) {
    assert.deepEqual(categories(t, text), ['email-review'], text);
  }
});

test('reserved, dotless and incomplete addresses need no review', (t) => {
  for (const text of [`${at('dev', 'example.com')}, ${at('a.b+c', 'sub.example.org')}`,
    at('a', 'b'), at('', 'corp.io'), at('a', '.io'), at('a', 'b.c')]) {
    assert.deepEqual(categories(t, text), [], text);
  }
});

test('long runs without an address are scanned in linear time', (t) => {
  const control = repository(t, 'a');
  let started = performance.now();
  auditRepository(control, []);
  const baseline = performance.now() - started;
  for (const text of ['a'.repeat(100_000), 'a@'.repeat(50_000), 'a@' + 'a.'.repeat(50_000)]) {
    const root = repository(t, text);
    started = performance.now();
    assert.deepEqual(auditRepository(root, []).issues, []);
    const elapsed = performance.now() - started - baseline;
    assert.ok(elapsed < 200, `${text.length} characters took ${elapsed.toFixed(1)} ms beyond the audit of one character`);
  }
});
