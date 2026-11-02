import { fail, payload, positive } from './contract.mts';
import type { Request } from './contract.mts';
import type { Identity } from './config.mts';
import type { Http } from './transport.mts';
import { matchesFields } from './receipt.mts';
import type { Receipt } from './receipt.mts';
export async function preflightIssue(http:Http, token:string, repo:string, issueNumber:number):Promise<void> {
  const issue=await http('GET',`/repos/${repo}/issues/${issueNumber}`,token);
  if (issue.number !== issueNumber || !positive(issue.id) || Object.hasOwn(issue,'pull_request') || issue.repository_url !== `https://api.github.com/repos/${repo}`) fail('target-refused');
}
export async function mutate(http:Http, token:string, request:Request):Promise<{issueNumber?:number; targetId?:number}> {
  const base=`/repos/${request.repository}/issues`;
  const endpoint=request.operation==='issue.create' ? base : `${base}/${request.issueNumber}${request.operation==='issue.comment'?'/comments':''}`;
  const result=await http(request.operation==='issue.update'?'PATCH':'POST',endpoint,token,payload(request));
  return { ...(positive(result.id)?{targetId:result.id}:{}), ...(request.operation==='issue.create' ? positive(result.number)?{issueNumber:result.number}:{} : {issueNumber:request.issueNumber}) };
}
export async function readback(http:Http, token:string, repo:string, identity:Identity, receipt:Receipt):Promise<void> {
  if (!receipt.issueNumber || !receipt.targetId) fail('outcome-unknown');
  const base=`/repos/${repo}/issues`, comment=receipt.operation==='issue.comment';
  const item=await http('GET',comment?`${base}/comments/${receipt.targetId}`:`${base}/${receipt.issueNumber}`,token);
  if (item.id !== receipt.targetId || !matchesFields(item,receipt.fieldHashes)) fail('verification-failed');
  if (comment) {
    if (item.issue_url !== `https://api.github.com${base}/${receipt.issueNumber}`) fail('verification-failed');
    await preflightIssue(http,token,repo,receipt.issueNumber);
  } else if (item.number !== receipt.issueNumber || Object.hasOwn(item,'pull_request') || item.repository_url !== `https://api.github.com/repos/${repo}`) fail('verification-failed');
  if (receipt.operation !== 'issue.update') {
    const actor=item.user as Record<string,unknown>;
    if (!actor || actor.id !== identity.botId || actor.login !== identity.botLogin || actor.type !== 'Bot') fail('verification-failed');
  }
}
