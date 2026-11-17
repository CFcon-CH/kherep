import { fail, isBotActor, pickIds, positive, SHA } from './contract.mts';
import { owner, pull } from './pulls.mts';
import type { Context, Handler } from './operations.mts';
// pr.merge merges one open pull request at the exact head the caller names. The
// broker evaluates no checks, reviews or rulesets: GitHub's branch rules enforce
// them at merge time and refuse the PUT otherwise.
const side = (value:unknown) => (value ?? {}) as Record<string, unknown>;
// config.mts admits pr.merge only for a repository with a merge entry.
const method = (c:Context) => c.identity.repositories.find(r => r.slug === c.repo.slug)?.merge?.method ?? fail('policy-invalid');
export const mergeHandler: Handler = {
  kind:'pull',
  fields:() => ({}),
  async preflight(c) {
    const r = c.request, slug = c.repo.slug;
    const item = await pull(c.http, c.token, slug, r.prNumber!, 'target-refused');
    // `mergeable` null means GitHub has not computed it yet: refuse; no receipt exists yet, so the caller may retry.
    if (item.state !== 'open' || item.merged !== false || item.draft !== false || side(item.base).ref !== c.target.default_branch
      || owner(item.head) !== slug || side(item.head).sha !== r.sha || item.mergeable !== true) fail('target-refused');
    return {prNumber:r.prNumber, targetId:item.id as number, sha:r.sha};
  },
  async mutate(c, _receipt, save) {
    // Known before the PUT: a lost answer is settled by verify or a retry, never by a second PUT.
    save({});
    const result = await c.http('PUT', `/repos/${c.repo.slug}/pulls/${c.request.prNumber}/merge`, c.token, {sha:c.request.sha, merge_method:method(c)});
    return typeof result.sha === 'string' && SHA.test(result.sha) ? {mergeSha:result.sha} : {};
  },
  known:receipt => positive(receipt.prNumber) && positive(receipt.targetId),
  async readback(c, receipt) {
    if (!receipt.prNumber || !receipt.targetId || !receipt.sha) fail('outcome-unknown');
    const item = await pull(c.http, c.token, c.repo.slug, receipt.prNumber, 'verification-failed');
    // GitHub omitted merge_commit_sha from the pull answer under a contents-only
    // installation token (observed on PR #959), so it is checked only when present.
    const commit = item.merge_commit_sha;
    if (item.id !== receipt.targetId || item.merged !== true || !isBotActor(c.identity, item.merged_by) || side(item.head).sha !== receipt.sha
      || (commit != null && (typeof commit !== 'string' || !SHA.test(commit)))) fail('verification-failed');
  },
  ids:receipt => pickIds(receipt, ['prNumber', 'targetId', 'mergeSha']),
  attribution:() => 'bot-actor',
};
