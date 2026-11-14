import { fail, isBotActor, pickIds, positive } from './contract.mts';
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
    let action='rerun';
    if (c.request.operation==='run.cancel') action='cancel';
    else if (c.request.failedOnly) action='rerun-failed-jobs';
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
    if (Number(run.run_attempt)<=receipt.attempt || !isBotActor(c.identity,run.triggering_actor)) fail('verification-failed');
  },
  ids:receipt=>pickIds(receipt,['runId','attempt']),
  attribution:receipt=>receipt.operation==='run.rerun'?'bot-actor':'authenticated-installation',
};
