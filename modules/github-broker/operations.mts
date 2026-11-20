import type { Operation, Request, Runtime } from './contract.mts';
import { noreply } from './config.mts';
import type { Identity } from './config.mts';
import type { Permissions } from './auth.mts';
import type { Http } from './transport.mts';
import type { Receipt } from './receipt.mts';
import { issueHandler } from './issues.mts';
import { pushHandler } from './git-push.mts';
import { pullHandler } from './pulls.mts';
import { runHandler } from './runs.mts';
import { mergeHandler } from './merge.mts';
import { branchDeleteHandler } from './branch-delete.mts';
export type Dependencies = {root?:string; fetch?:typeof fetch; now?:()=>number; cwd?:string; push?:{url?:string; helperScript?:string}; env?:NodeJS.ProcessEnv};
/** Everything one operation needs after policy, admission and authentication; `permit` creates the operation's one credential grant (see ReceiptStore.permit) and returns its nonce and remover. */
export type Context = {http:Http; token:string; target:Record<string,unknown>; request:Request; identity:Identity; repo:{slug:string; id:number}; runtime:Runtime; now:number; deps:Dependencies; permit:()=>{nonce:string; revoke:()=>void}};
export type Kind = 'issue'|'push'|'pull'|'run'|'branch';
export type Handler = {
  kind:Kind;
  /** Values whose hashes the receipt keeps for the exact readback. */
  fields:(request:Request)=>Record<string,unknown>;
  /** Target checks before the write-ahead receipt; returns the receipt fields known at admission. */
  preflight:(c:Context)=>Promise<Partial<Receipt>>;
  /** The one provider effect. `save` persists IDs learned before a later step fails. */
  mutate:(c:Context, receipt:Receipt, save:(known:Partial<Receipt>)=>void)=>Promise<Partial<Receipt>>;
  known:(receipt:Receipt)=>boolean;
  readback:(c:Context, receipt:Receipt)=>Promise<void>;
  ids:(receipt:Receipt)=>Record<string,unknown>;
  attribution:(receipt:Receipt)=>string;
  /** After a verified write of this run only: records it in the attribution log; false when nothing was written. */
  recorded?:(c:Context, receipt:Receipt)=>boolean;
  /** Provider requests one invocation may make, authentication included; default 10. */
  requests?:number;
};
export const HANDLERS: Record<Operation, Handler> = {
  'issue.create':issueHandler, 'issue.comment':issueHandler, 'issue.update':issueHandler,
  'branch.push':pushHandler, 'pr.create':pullHandler, 'pr.update':pullHandler, 'pr.comment':pullHandler,
  'run.rerun':runHandler, 'run.cancel':runHandler, 'pr.merge':mergeHandler, 'branch.delete':branchDeleteHandler,
};
/**
 * The exact installation-token permissions per operation. Authentication requests
 * this set, and refuses a token that carries anything beyond it and metadata:read.
 * Labels on a new pull request are written through the issue labels of that PR.
 */
export function permissionsFor(operation:Operation, labels:boolean):Permissions {
  if (operation.startsWith('issue.')) return {issues:'write'};
  if (operation==='branch.push'||operation==='pr.merge'||operation==='branch.delete') return {contents:'write'};
  if (operation.startsWith('run.')) return {actions:'write'};
  return operation==='pr.create' && labels ? {pull_requests:'write', issues:'write'} : {pull_requests:'write'};
}
/** The public commit identity of a runtime's bot, as GitHub attributes it. */
export function botIdentity(identity:Identity):{name:string; email:string} {
  return {name:identity.botLogin, email:noreply(identity.botId,identity.botLogin)};
}
