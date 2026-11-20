import { fail, pickIds, positive, refName } from './contract.mts';
import type { RefusalReason } from './contract.mts';
import { noreply } from './config.mts';
import { ABSENT } from './transport.mts';
import { remoteSha } from './git-push.mts';
import { owner } from './pulls.mts';
import type { Handler } from './operations.mts';
// branch.delete removes the head branch of one closed pull request of this
// repository, written by a configured bot, when the branch still points at that
// pull request's saved head. GitHub's REST delete takes no expected SHA, so the
// branch head is read last and a push landing between that read and the DELETE
// is not refused (the documented residual window).
const refuse = (reason:RefusalReason):never => fail('target-refused', reason);
const side = (value:unknown) => (value ?? {}) as Record<string, unknown>;
// A head list of this many pulls is not known to be complete; GitHub's own default page size, far below the 1 MiB answer cap.
const PAGE = 30;
export const branchDeleteHandler: Handler = {
  kind:'branch',
  fields:() => ({}),
  requests:12,
  async preflight(c) {
    const {branch, sha, prNumber} = c.request as {branch:string; sha:string; prNumber:number};
    const slug = c.repo.slug, repo = `/repos/${slug}`, main = c.target.default_branch;
    if (typeof main !== 'string' || !refName(main)) refuse('unexpected-answer');
    if (branch === main) refuse('default-branch');
    // Every pull request whose head is this branch, in any state.
    const heads = (await c.http('GET', `${repo}/pulls?state=all&head=${slug.split('/')[0]}:${branch}&per_page=${PAGE}`, c.token, undefined, false, true)).items;
    if (!Array.isArray(heads) || heads.length >= PAGE) refuse('pull-list-incomplete');
    const list = heads as Record<string, unknown>[];
    if (list.some(item => typeof item?.head !== 'object' || item.head === null)) refuse('unexpected-answer');
    if (list.some(item => item.state === 'open')) refuse('open-pull-request');
    const pr = list.find(item => item.number === prNumber) ?? refuse('pull-not-found');
    if (!positive(pr.id) || owner(pr.base) !== slug) refuse('unexpected-answer');
    if (pr.state !== 'closed') refuse('pull-not-closed');
    if (owner(pr.head) !== slug) refuse('foreign-head');
    if (side(pr.head).ref !== branch || side(pr.head).sha !== sha) refuse('pull-head-mismatch');
    // allowedAuthorBotIds (default: the runtime's own bot) also decides whose pull request branches it may delete.
    const user = side(pr.user);
    if (user.type !== 'Bot' || !positive(user.id) || typeof user.login !== 'string' || !(c.identity.authorEmails ?? []).includes(noreply(user.id, user.login).toLowerCase())) refuse('foreign-author');
    const bases = (await c.http('GET', `${repo}/pulls?state=open&base=${branch}&per_page=1`, c.token, undefined, false, true)).items;
    if (!Array.isArray(bases)) refuse('unexpected-answer');
    if ((bases as unknown[]).length) refuse('open-base-pull-request');
    const rules = (await c.http('GET', `${repo}/rules/branches/${branch}`, c.token, undefined, false, true)).items;
    if (!Array.isArray(rules)) refuse('unexpected-answer');
    if ((rules as unknown[]).length) refuse('branch-rules');
    // GitHub keeps refs/pull/<n>/head after the branch is gone: the commit stays reachable.
    const saved = await c.http('GET', `${repo}/git/ref/pull/${prNumber}/head`, c.token, undefined, true);
    if (saved === ABSENT || saved.ref !== `refs/pull/${prNumber}/head` || side(saved.object).type !== 'commit' || side(saved.object).sha !== sha) refuse('pull-ref-mismatch');
    // Last read before the DELETE, so the unguarded window stays one request.
    const admitted = {branch, sha, prNumber, targetId:pr.id as number};
    const current = await c.http('GET', `${repo}/branches/${branch}`, c.token, undefined, true);
    if (current === ABSENT) return {...admitted, result:'absent'};
    if (current.name !== branch || typeof side(current.commit).sha !== 'string') refuse('unexpected-answer');
    if (current.protected !== false) refuse('protected-branch');
    if (side(current.commit).sha !== sha) refuse('head-moved');
    return admitted;
  },
  async mutate(c, receipt, save) {
    if (receipt.result === 'absent') return {};
    // Known before the DELETE: a lost answer is settled by verify or a retry, never by a second DELETE.
    save({});
    await c.http('DELETE', `/repos/${c.repo.slug}/git/refs/heads/${receipt.branch}`, c.token);
    return {result:'deleted'};
  },
  known:receipt => typeof receipt.branch === 'string' && typeof receipt.sha === 'string' && positive(receipt.prNumber),
  async readback(c, receipt) {
    if (!receipt.branch || !receipt.sha || !positive(receipt.prNumber)) fail('outcome-unknown');
    if (await remoteSha(c, receipt.branch, 'verification-failed') !== undefined) fail('verification-failed');
  },
  // `result` only on a verified receipt: a failure, or verify of a receipt not yet verified, names none.
  ids:receipt => ({...pickIds(receipt, ['branch', 'sha', 'prNumber']), ...(receipt.status === 'verified' ? {result:receipt.result ?? 'absent'} : {})}),
  attribution:() => 'authenticated-installation',
};
