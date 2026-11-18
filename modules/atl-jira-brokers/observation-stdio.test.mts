// Issue #965: the refusal branches of the observation stdio adapter - request metadata, the candidates
// tool, framing limits and the process entry. Injected publish and candidates; no broker, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observationRpc, serveObservations } from './observation-stdio.mts';

const ADAPTER = path.join(import.meta.dirname, 'observation-stdio.mts');
const call = (params: unknown, id: unknown = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params });
const never = async (): Promise<string> => { throw new Error('publish must not run'); };
const errorOf = (response: unknown) => (response as { error?: { message?: string } }).error?.message;

test('request metadata that is not a plain bounded object is refused before publishing', async () => {
  let published = 0;
  const publish = async () => { published += 1; return 'OBS-RESULT: empty no-admissible-findings'; };
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const meta of [new Map(), [], { progressToken: true }, { progressToken: Number.NaN }, circular, { big: 'x'.repeat(5000) }]) {
    const response = await observationRpc(call({ name: 'publish_observations', arguments: {}, _meta: meta }), publish);
    assert.equal(errorOf(response), 'invalid-parameters');
  }
  const accepted = await observationRpc(call({ name: 'publish_observations', arguments: {}, _meta: Object.create(null) }), publish);
  assert.equal(errorOf(accepted), undefined);
  assert.equal(published, 1);
});

test('initialize and ping answer, and a non-object request is invalid with a null id', async () => {
  const init = await observationRpc({ jsonrpc: '2.0', id: 0, method: 'initialize' }, never) as { result: { serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, 'kherep-observations');
  assert.deepEqual(await observationRpc({ jsonrpc: '2.0', id: 'p-1', method: 'ping' }, never), { jsonrpc: '2.0', id: 'p-1', result: {} });
  assert.deepEqual(await observationRpc(null, never), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid-request' } });
});

test('related_candidates returns a well-formed result and maps anything else to an unknown outcome', async () => {
  const args = { name: 'related_candidates', arguments: {} };
  const ok = await observationRpc(call(args), never, async () => ({ text: `OBS-CANDIDATES: ok ${'a'.repeat(64)} 2`, isError: false }));
  assert.deepEqual((ok as { result: unknown }).result, { content: [{ type: 'text', text: `OBS-CANDIDATES: ok ${'a'.repeat(64)} 2` }], isError: false });
  assert.equal(errorOf(await observationRpc(call(args), never, async () => ({ text: 'free text', isError: false }))), 'candidates-outcome-unknown');
  assert.equal(errorOf(await observationRpc(call(args), never, async () => { throw new Error('synthetic'); })), 'candidates-outcome-unknown');
  // Without a candidates surface the tool does not exist on this server.
  assert.equal(errorOf(await observationRpc(call(args), never)), 'method-unavailable');
});

test('a publish receipt that is not an OBS-RESULT is an unknown outcome, not a success', async () => {
  const response = await observationRpc(call({ name: 'publish_observations', arguments: {} }), async () => 'wrote something');
  assert.equal(errorOf(response), 'publication-outcome-unknown');
});

async function serve(chunks: (string | Buffer)[]): Promise<string[]> {
  const lines: string[] = [];
  await serveObservations((async function* () { yield* chunks; })(), (line) => lines.push(line), never);
  return lines;
}

test('serve answers an unparseable line as invalid and accepts string chunks split mid-line', async () => {
  const lines = await serve(['not json\n{"jsonrpc":"2.0","id":2,', '"method":"ping"}\n']);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid-request' } },
    { jsonrpc: '2.0', id: 2, result: {} },
  ]);
});

test('serve refuses an oversized line, an oversized pending tail and an unterminated tail', async () => {
  const big = 'x'.repeat(600_001);
  await assert.rejects(() => serve([`${big}\n`]), /invalid-request/);
  await assert.rejects(() => serve([big]), /invalid-request/);
  await assert.rejects(() => serve(['{"jsonrpc":"2.0"']), /invalid-request/);
});

test('the process entry refuses extra arguments and answers an invalid publication request', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-stdio-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? '', CODEX_HOME: path.join(home, 'absent') };
  const extra = spawnSync(process.execPath, [ADAPTER, 'unexpected'], { encoding: 'utf8', timeout: 20_000, env, input: '' });
  assert.equal(extra.status, 1);
  assert.equal(extra.stderr, 'observation-adapter-unavailable\n');

  // Without CODEX_HOME the adapter falls back to <home>/.codex; home is this test's directory.
  const input = `${JSON.stringify(call({ name: 'publish_observations', arguments: { bogus: true } }))}\n`;
  const invalid = spawnSync(process.execPath, [ADAPTER], {
    encoding: 'utf8', timeout: 20_000, env: { PATH: env.PATH, HOME: home, USERPROFILE: home }, input,
  });
  assert.equal(invalid.status, 0, invalid.stderr);
  const response = JSON.parse(invalid.stdout.trim());
  assert.deepEqual(response.result, { content: [{ type: 'text', text: 'OBS-RESULT: failed invalid-request' }], isError: true });
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);
});

test('imported without its own script path the adapter does not serve', () => {
  // No script path at all, and one that does not exist: neither may run the entry point.
  for (const argv of [[], [path.join(os.tmpdir(), `kherep-absent-${process.pid}`, 'entry.mts')]]) {
    const proc = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(ADAPTER)});`, ...argv], {
      encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH ?? '' }, input: '',
    });
    assert.equal(proc.status, 0);
    assert.equal(proc.stdout, '');
  }
});
