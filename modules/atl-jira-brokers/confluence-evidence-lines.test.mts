// Issue #906. Line labels of a claim are found at a line start through horizontal
// whitespace only, and a URL query naming a credential is found by a scan of one
// run instead of a backtracking expression. Secret samples are assembled at runtime.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaim, decide, type Measurement } from './confluence-evidence.mts';

const SHA = 'a'.repeat(40);
const NOW = new Date(2026, 9, 22, 12).getTime();
const pad = (n: number) => String(n).padStart(2, '0');
const today = () => { const d = new Date(NOW); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const LABELS = ['type-observation', 'evidence-assumed', 'status-author-model', 'runtime-claude-code-win'];
const BASE = `<p>Revision: alpha@${SHA}</p><p>Code: src/queue.mts</p><p>Queue retries keep receipt identity.</p>`;
const snap = (body: string) => ({ id: '1', version: 3, title: 'Synthetic title', spaceId: '9', parentId: null, body, labels: LABELS });
const signals = (body: string) => classifyClaim(snap(body), true).signals;
const M = (over: Record<string, unknown> = {}): Measurement => ({ kind: 'code', source: 'alpha (git checkout)', sourceClass: 'repository',
  command: `git -C /x/alpha show ${SHA}:src/queue.mts | grep -n retry`, excerpt: '12: retry(receipt)', measuredAt: today(),
  verdict: 'reproduces', revision: `alpha@${SHA}`, ...over } as Measurement);
const OPT = { now: NOW, repoRoot: '/x/alpha', repoTopLevel: '/x/alpha', revisionExists: (sha: string) => sha === SHA };
const excerpt = (sample: string) => decide(classifyClaim(snap(BASE), true), M({ excerpt: `12: retry(receipt) ${sample}` }), OPT);
const timed = (run: () => void): number => { const started = performance.now(); run(); return performance.now() - started; };

test('code, live and doc labels count only at a line start', () => {
  for (const body of ['<p>Repository: x</p>', '<p>\u00a0 commit :x</p>']) assert.ok(signals(body).includes('code'), body);
  assert.ok(!signals('<p>my Repo: x</p>').includes('code'));
  for (const body of ['<p>Host: a</p>', '<p>x</p><p>  LIVE : y</p>']) assert.ok(signals(body).includes('live'), body);
  assert.ok(!signals('<p>the Host: a</p>').includes('live'));
  for (const body of ['<p>Doc: a</p>', '<p>documentation :b</p>']) assert.ok(signals(body).includes('doc'), body);
  for (const body of ['<p>Docs: a</p>', '<p>a Doc: b</p>']) assert.ok(!signals(body).includes('doc'), body);
  const elapsed = timed(() => signals('\n'.repeat(50_000)));
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
});

test('a URL query that names a credential refuses the excerpt, other queries do not', () => {
  const key = (name: string) => `${name}=`;
  for (const sample of [`GET https://h.example/x?${key('token')}1`, `see https://h.example/x?a=1&${key('SIG')}2 now`,
    `x://y://z?${key('key')}`, `a1+.-://?${key('sig')}`]) {
    assert.equal(excerpt(sample).reason, 'excerpt-secret-marker', sample);
  }
  for (const sample of ['https://h.example/x?a=1', `https://h.example/x #?${key('key')}1`, `https://h.example/x? ${key('key')}1`,
    `1://x?${key('key')}`, `://x?${key('key')}1`]) {
    assert.equal(excerpt(sample).outcome, 'confirmed', sample);
  }
});

test('a long run of scheme separators is checked in linear time', () => {
  const run = () => decide(classifyClaim(snap(BASE), true), M({ command: 'a://'.repeat(50_000) }), OPT);
  let reason = '';
  const elapsed = timed(() => { reason = run().reason; });
  assert.notEqual(reason, 'excerpt-secret-marker');
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
});
