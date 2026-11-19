// Issue #906. Address-shaped text is found by a scan anchored on each "@"
// instead of a backtracking expression. Every address is assembled at runtime,
// so this file itself carries no address-shaped text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { auditRepository, emailAddresses } from './publication-audit.mts';

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

const N = 25_000;
const longRuns = [(size: number) => 'a'.repeat(size), (size: number) => 'a@'.repeat(size / 2),
  (size: number) => 'a@' + 'a.'.repeat(size / 2)];

// The fastest of nine scans after a warm-up, so one scheduler or collector pause cannot decide.
function fastest(text: string): number {
  emailAddresses(text);
  let best = Infinity;
  for (let run = 0; run < 9; run += 1) {
    const started = performance.now();
    emailAddresses(text);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

test('long runs without an address need no review', (t) => {
  for (const shape of longRuns) assert.deepEqual(auditRepository(repository(t, shape(4 * N)), []).issues, []);
});

test('long runs without an address are scanned in linear time', (t) => {
  // Issue #983: only the scanner is timed, n against 4n characters. Linear growth is about four times,
  // quadratic growth sixteen. The floor keeps millisecond timings, where JIT tiering or one collector
  // pause can exceed eight times, from deciding (#995); the pre-#906 regex takes seconds at these sizes.
  for (const shape of longRuns) {
    const small = fastest(shape(N));
    const large = fastest(shape(4 * N));
    const label = `${JSON.stringify(shape(4).slice(0, 4))}: ${4 * N} characters took ${large.toFixed(2)} ms, ${N} took ${small.toFixed(2)} ms`;
    t.diagnostic(label);
    assert.ok(large <= Math.max(8 * small, 50), label);
  }
});
