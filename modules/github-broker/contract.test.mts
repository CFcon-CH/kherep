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
test('labels are optional on issue.create only, bounded and unambiguous', async () => {
  const { parseRequest, payload } = await import('./contract.mts');
  const input = { operationId: id, repository: 'example/project', operation: 'issue.create', title: 'Synthetic' };
  const labels = ['cp:intercom', 'bug'];
  assert.deepEqual(payload(parseRequest(JSON.stringify({ ...input, labels }))), { title: 'Synthetic', labels });
  assert.deepEqual(payload(parseRequest(JSON.stringify(input))), { title: 'Synthetic' });
  for (const bad of [[], 'x', ['a', 'a'], [''], [' a'], ['a,b'], [1], ['x'.repeat(51)], Array.from({ length: 21 }, (_, i) => `l${i}`)]) {
    assert.throws(() => parseRequest(JSON.stringify({ ...input, labels: bad })), /invalid-request/, JSON.stringify(bad));
  }
  assert.equal(parseRequest(JSON.stringify({ ...input, labels: Array.from({ length: 20 }, (_, i) => `l${i}`) })).labels?.length, 20);
  for (const other of [{ operation: 'issue.comment', issueNumber: 7, body: 'x' }, { operation: 'issue.update', issueNumber: 7, title: 'x' }, { operation: 'verify' }]) {
    assert.throws(() => parseRequest(JSON.stringify({ operationId: id, repository: 'example/project', ...other, labels })), /invalid-request/, other.operation);
  }
});
test('pr.merge takes exactly a required prNumber and a lowercase 40-hex sha', async () => {
  const { parseRequest } = await import('./contract.mts');
  const input = { operationId: id, repository: 'example/project', operation: 'pr.merge', prNumber: 7, sha: 'a'.repeat(40) };
  assert.deepEqual(parseRequest(JSON.stringify(input)), input);
  for (const bad of [{ sha: undefined }, { prNumber: undefined }, { sha: 'A'.repeat(40) }, { sha: 'a'.repeat(39) }, { method: 'squash' }, { title: 'x' }]) {
    assert.throws(() => parseRequest(JSON.stringify({ ...input, ...bad })), /invalid-request/, JSON.stringify(bad));
  }
});
test('branch.delete takes exactly a required branch, lowercase 40-hex sha and positive prNumber', async () => {
  const { parseRequest } = await import('./contract.mts');
  const input = { operationId: id, repository: 'example/project', operation: 'branch.delete', branch: 'feat/old', sha: 'a'.repeat(40), prNumber: 7 };
  assert.deepEqual(parseRequest(JSON.stringify(input)), input);
  for (const bad of [{ branch: undefined }, { sha: undefined }, { prNumber: undefined }, { branch: '-x' }, { branch: 'refs/heads/x/' }, { sha: 'A'.repeat(40) }, { prNumber: 0 }, { force: true }]) {
    assert.throws(() => parseRequest(JSON.stringify({ ...input, ...bad })), /invalid-request/, JSON.stringify(bad));
  }
});
