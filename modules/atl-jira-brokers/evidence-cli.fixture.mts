// Test harness of the evidence verb: injected session, git and file operations only.
// Nothing here reaches a network, a real repository, a real file or a Confluence page.
import assert from 'node:assert/strict';
import { cmdEvidence } from './confluence-evidence-cli.mts';
import { ConfluenceError, type ConfluenceSession, type RequestSpec } from './confluence-contract.mts';
import type { FileOps } from './confluence-evidence-io.mts';
import type { NeighbourCliContext } from './confluence-neighbour-cli.mts';
import type { ExecLike } from './confluence-semantic.mts';

export const SHA = 'a'.repeat(40);
export const NOW = new Date(2026, 9, 22, 12).getTime();
export const TODAY = '2026-10-22';
export const BODY = `<p>Revision: alpha@${SHA}</p><p>Code: src/queue.mts</p><p>Queue retries keep receipt identity.</p><h2>Related pages</h2>`;
export const LABELS = ['type-observation', 'evidence-assumed', 'status-author-model', 'runtime-claude-code-win'];
export const MEASUREMENT = { kind: 'code', source: 'alpha (git checkout)', sourceClass: 'repository', command: `git show ${SHA}:src/queue.mts`,
  excerpt: '12: retry(receipt)', measuredAt: TODAY, verdict: 'reproduces', revision: `alpha@${SHA}` };
// #695: a confirmed record, a commit newer than SHA and a contradicting measurement of the same claim.
export const CONFIRMED = ['type-observation', 'evidence-confirmed', 'status-author-model', 'runtime-claude-code-win'];
export const NEWER = 'c'.repeat(40);
export const CONTRADICTS = { ...MEASUREMENT, verdict: 'contradicts' };
export type Pages = Record<string, { body: string; labels: string[]; spaceId?: string; status?: string }>;
// links maps a directory to its resolved real path; a directory mapped to null does not exist.
// files replaces the in-memory files (with real ones, say); onRequest runs before each GET; mergeBase is what
// git merge-base prints (absent: the call fails).
export interface HarnessOptions { exec?: ExecLike; links?: Record<string, string | null>; files?: FileOps; onRequest?: () => void; mergeBase?: string }

export function harness(pages: Pages = { '1': { body: BODY, labels: LABELS } }, options: HarnessOptions = {}) {
  const calls: RequestSpec[] = [];
  const execs: string[][] = [];
  const files = new Map<string, string>();
  const out: string[] = [];
  const session: ConfluenceSession = { async request(spec) {
    assert.equal(spec.method, 'GET', 'the evidence verb never writes to Confluence');
    options.onRequest?.();
    calls.push(spec);
    if (spec.path.includes('/spaces?')) return { status: 200, json: { results: [{ id: '9', key: 'K', name: 'Space' }] } };
    const id = /\/pages\/(\d+)/.exec(spec.path)?.[1] ?? '';
    const p = pages[id];
    if (spec.path.includes('/labels')) return { status: 200, json: { results: p.labels.map(name => ({ name })) } };
    return { status: 200, json: { id, title: 'Synthetic title', spaceId: p.spaceId ?? '9', status: p.status ?? 'current', parentId: null,
      version: { number: 3 }, body: { storage: { value: p.body } }, authorId: 'svc', _links: {} } };
  } };
  const git: ExecLike = async (file, args) => {
    if (args[0] === '--version') return { stdout: 'git version 2.50.0\n', stderr: '' };
    const dir = args[1] ?? '';
    if (args.includes('cat-file')) return { stdout: 'commit\n', stderr: '' };
    if (args.includes('merge-base')) { if (options.mergeBase === undefined) throw new Error('fatal: merge-base failed'); return { stdout: `${options.mergeBase}\n`, stderr: '' }; }
    if (dir.startsWith('/x/') || dir.startsWith('/repo')) return { stdout: dir.split('/').slice(0, 3).join('/') + '\n', stderr: '' };
    if (dir.startsWith('/dubious')) throw new Error(`fatal: detected dubious ownership in repository at '${dir}'`);
    throw new Error('fatal: not a git repository (or any of the parent directories): .git');
  };
  const exec: ExecLike = async (file, args, opts) => { execs.push([file, ...args]); return (options.exec ?? git)(file, args, opts); };
  // The broker joins the resolved directory with the platform separator; the in-memory keys use '/'.
  const key = (path: string) => path.replace(/\\/g, '/');
  const ctx = { env: {}, credEnv: 'KHEREP_ATL_CRED_FILE_CLAUDE', session: {}, now: () => NOW,
    readFile: async (path: string) => { const v = files.get(key(path)); if (v === undefined) throw new Error('missing'); return v; },
    log: (line: string) => out.push(line), logError: (line: string) => out.push(line) } as unknown as NeighbourCliContext;
  const realpath = async (dir: string) => {
    const target = options.links?.[dir];
    if (target === null) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    return target ?? dir;
  };
  const write = async (path: string, data: string) => { files.set(key(path), data); };
  const create = async (path: string, data: string) => {
    if (files.has(key(path))) throw new ConfluenceError('out-exists: the file appeared after the check.');
    files.set(key(path), data);
  };
  const exists = async (path: string) => files.has(key(path));
  const deps = { session, exec, files: options.files ?? { write, create, exists, realpath } };
  const run = (args: Record<string, string | undefined>) => cmdEvidence(ctx, args, deps);
  return { calls, execs, files, out, run };
}
// An absolute namespace for Map keys only; never a host temporary directory.
export const prepareArgs = { mode: 'prepare', id: '1', space: 'K', out: '/synthetic/evidence/r.json', 'body-approved': undefined };
export const decideArgs = { mode: 'decide', record: '/synthetic/evidence/r.json', measurement: '/synthetic/evidence/m.json', 'out-body': '/synthetic/evidence/b.xml', 'repo-root': '/x/alpha' };
export async function prepared(h = harness(), measurement: object = MEASUREMENT, args: Record<string, string | undefined> = prepareArgs) {
  assert.equal(await h.run(args), 0);
  h.files.set('/synthetic/evidence/m.json', JSON.stringify(measurement));
  h.calls.length = 0;
  return h;
}
