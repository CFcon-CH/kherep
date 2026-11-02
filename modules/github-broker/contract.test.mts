import assert from 'node:assert/strict';
import test from 'node:test';
const id = '550e8400-e29b-41d4-a716-446655440000';
test('strict bounded contract refuses overrides and accepts explicit writes', async () => {
  const { parseRequest } = await import('./contract.mts');
  const input = { operationId: id, repository: 'example/project', operation: 'issue.create', title: 'Synthetic', body: 'Test' };
  assert.equal(parseRequest(JSON.stringify(input)).operation, 'issue.create');
  for (const extra of [{ runtime: 'codex' }, { approved: true }, { token: 'canary' }, { url: 'https://example.com' }]) {
    assert.throws(() => parseRequest(JSON.stringify({ ...input, ...extra })));
  }
  for (const bad of [{...input, repository:'../project'}, {...input,title:'x'.repeat(257)}, {...input, body:'x'.repeat(32769)}, {...input, operationId:'bad'}]) assert.throws(() => parseRequest(JSON.stringify(bad)));
});
test('both constant-runtime CLI entrypoints are import safe and default disabled', async () => {
  for (const runtime of ['claude', 'codex']) {
    const { run } = await import(`./github-${runtime}.mts`);
    const result = await run(JSON.stringify({operationId:id, repository:'example/project', operation:'issue.create', title:'Test'}), {root:'/nonexistent-synthetic-broker'});
    assert.deepEqual(result, {ok:false,error:'policy-disabled'});
  }
});
