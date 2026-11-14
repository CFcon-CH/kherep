import { fail, isBotActor, pickIds, positive } from './contract.mts';
import type { Request } from './contract.mts';
import type { Http } from './transport.mts';
import { matchesFields } from './receipt.mts';
import type { Receipt } from './receipt.mts';
import type { Context, Handler } from './operations.mts';
const PR_FIELDS = ['title','body','state','base','head','draft','labels'] as const;
type Code = 'target-refused'|'verification-failed';
const owner = (value:unknown) => (value as {repo?:{full_name?:unknown}}|null)?.repo?.full_name;
async function pull(http:Http, token:string, repo:string, prNumber:number, code:Code):Promise<Record<string,unknown>> {
  const item=await http('GET',`/repos/${repo}/pulls/${prNumber}`,token);
  if (item.number!==prNumber || !positive(item.id) || owner(item.base)!==repo) fail(code);
  return item;
}
// The pull request in the shape of the request fields, so the receipt hashes compare.
function project(item:Record<string,unknown>):Record<string,unknown> {
  const ref=(side:unknown)=>(side as {ref?:unknown}|null)?.ref;
  return {title:item.title, body:item.body, state:item.state, draft:item.draft, base:ref(item.base), head:ref(item.head), labels:item.labels};
}
async function create(c:Context, save:(known:Partial<Receipt>)=>void):Promise<Partial<Receipt>> {
  const r=c.request, base=`/repos/${c.repo.slug}`;
  const created=await c.http('POST',`${base}/pulls`,c.token,{title:r.title,head:r.head,base:r.base,...(r.body!==undefined?{body:r.body}:{}),...(r.draft!==undefined?{draft:r.draft}:{})});
  const known={...(positive(created.number)?{prNumber:created.number}:{}),...(positive(created.id)?{targetId:created.id}:{})};
  if (!r.labels) return known;
  // A PR is an issue: its labels are set on the issue. Persist the PR first, so a
  // failing label call cannot hide that the pull request exists.
  if (!known.prNumber || !known.targetId) fail('outcome-unknown');
  save(known);
  await c.http('PATCH',`${base}/issues/${known.prNumber}`,c.token,{labels:r.labels});
  return known;
}
export const pullHandler: Handler = {
  kind:'pull',
  fields:(r:Request)=>r.operation==='pr.comment' ? {body:r.body} : Object.fromEntries(PR_FIELDS.filter(k=>r[k]!==undefined).map(k=>[k,r[k]])),
  async preflight(c) {
    if (c.request.operation==='pr.create') return {};
    await pull(c.http,c.token,c.repo.slug,c.request.prNumber!,'target-refused');
    return {prNumber:c.request.prNumber};
  },
  async mutate(c, _receipt, save) {
    const r=c.request, base=`/repos/${c.repo.slug}`;
    if (r.operation==='pr.create') return create(c,save);
    if (r.operation==='pr.comment') {
      const comment=await c.http('POST',`${base}/issues/${r.prNumber}/comments`,c.token,{body:r.body});
      return positive(comment.id)?{targetId:comment.id}:{};
    }
    const updated=await c.http('PATCH',`${base}/pulls/${r.prNumber}`,c.token,pullHandler.fields(r));
    return positive(updated.id)?{targetId:updated.id}:{};
  },
  known:receipt=>positive(receipt.prNumber) && positive(receipt.targetId),
  async readback(c, receipt) {
    if (!receipt.prNumber || !receipt.targetId) fail('outcome-unknown');
    const repo=c.repo.slug;
    if (receipt.operation==='pr.comment') {
      const comment=await c.http('GET',`/repos/${repo}/issues/comments/${receipt.targetId}`,c.token);
      if (comment.id!==receipt.targetId || !matchesFields(comment,receipt.fieldHashes) || comment.issue_url!==`https://api.github.com/repos/${repo}/issues/${receipt.prNumber}` || !isBotActor(c.identity,comment.user)) fail('verification-failed');
      await pull(c.http,c.token,repo,receipt.prNumber,'verification-failed');
      return;
    }
    const item=await pull(c.http,c.token,repo,receipt.prNumber,'verification-failed');
    if (item.id!==receipt.targetId || !matchesFields(project(item),receipt.fieldHashes)) fail('verification-failed');
    if (receipt.operation==='pr.create' && (owner(item.head)!==repo || !isBotActor(c.identity,item.user))) fail('verification-failed');
  },
  ids:receipt=>pickIds(receipt,['prNumber','targetId']),
  attribution:receipt=>receipt.operation==='pr.update'?'authenticated-installation':'bot-author',
};
