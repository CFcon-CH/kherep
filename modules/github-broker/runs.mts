import { fail, positive } from './contract.mts';
import type { Context, Handler } from './operations.mts';
type Code = 'target-refused'|'verification-failed';
async function readRun(c:Context, runId:number, code:Code):Promise<Record<string,unknown>> {
  const run=await c.http('GET',`/repos/${c.repo.slug}/actions/runs/${runId}`,c.token);
  const repository=run.repository as Record<string,unknown>|null;
  if (run.id!==runId || !positive(run.run_attempt) || repository?.id!==c.repo.id || repository?.full_name!==c.repo.slug) fail(code);
  return run;
}
export const runHandler: Handler = {
  kind:'run',
  fields:()=>({}),
  async preflight(c) {
    const runId=c.request.runId!, run=await readRun(c,runId,'target-refused');
    // GitHub reruns only a completed run and cancels only one still running.
    if ((c.request.operation==='run.rerun') !== (run.status==='completed')) fail('target-refused');
    return {runId, attempt:run.run_attempt as number};
  },
  async mutate(c) {
    const action=c.request.operation==='run.cancel' ? 'cancel' : c.request.failedOnly ? 'rerun-failed-jobs' : 'rerun';
    await c.http('POST',`/repos/${c.repo.slug}/actions/runs/${c.request.runId}/${action}`,c.token);
    return {};
  },
  known:receipt=>positive(receipt.runId) && positive(receipt.attempt),
  async readback(c, receipt) {
    if (!receipt.runId || !receipt.attempt) fail('outcome-unknown');
    const run=await readRun(c,receipt.runId,'verification-failed');
    if (receipt.operation==='run.cancel') {
      // Cancellation is asynchronous; until GitHub reports it, verify again later.
      if (run.conclusion!=='cancelled') fail('verification-failed');
      return;
    }
    const actor=run.triggering_actor as Record<string,unknown>|null;
    if (Number(run.run_attempt)<=receipt.attempt || actor?.id!==c.identity.botId || actor?.login!==c.identity.botLogin || actor?.type!=='Bot') fail('verification-failed');
  },
  ids:receipt=>({...(receipt.runId?{runId:receipt.runId}:{}),...(receipt.attempt?{attempt:receipt.attempt}:{})}),
  attribution:receipt=>receipt.operation==='run.rerun'?'bot-actor':'authenticated-installation',
};
