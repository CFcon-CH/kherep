import assert from "node:assert/strict";
import test from "node:test";
import { resumedHandover, T, S1, S3, M2 } from "./closed-resume-handover-fixture.mts";
import { withDiagnostics } from "./handover-diagnostics-fixture.mts";

test("immediate resume repairs the prior intermediate before a later watch can observe a change", (t) =>
  withDiagnostics("immediate-resume/normal", async (d) => {
    const { afterResume: r, entry, finish } = await resumedHandover(t, d);
    assert.equal(r.task.sessionId, S3);
    for (const m of r.records) {
      assert.deepEqual(m, { ...entry.find((e) => e.messageId === m.messageId)!, toSession: S3,
        delivery: { taskId: T, runtime: "claude", sessionId: S3 } }, "immediate adoption must recover old intermediate and identity");
    }
    assert.deepEqual(r.q.delivery, { taskId: T, runtime: "claude", sessionId: S3 });
    assert.ok(r.audits.some((a) => a.outcome === "reused" && a.reason === "intercom session resumed"));
    await finish();
  }));

for (const phase of ["address", "identity"] as const) {
  test(`a resumed copy with ${phase} contention restores old mapping and converges without another resume`, (t) =>
    withDiagnostics(`immediate-resume/${phase}`, async (d) => {
      const { afterResume: r, finish } = await resumedHandover(t, d, phase);
      assert.deepEqual([r.task.sessionId, r.task.shortId, r.task.state], [S1, "c0ffee03", "started"]);
      assert.ok(r.task.mappingPendingSince);
      assert.ok(r.logs.some((l) => l.includes(M2) && l.includes("RECORD_LOCK_BUSY")));
      assert.equal(r.records[1]!.state, "accepted");
      assert.equal(r.records[1]!.toSession, phase === "address" ? S1 : S3);
      assert.equal(r.records[1]!.delivery?.sessionId, S1);
      assert.ok(r.audits.some((a) => a.outcome === "reused" && a.reason === "intercom session resumed"));
      await finish();
    }));
}

for(const phase of [undefined,'address','identity'] as const)test(`strict immutable handover resumes M1/M2 once and leaves later Q separate (${phase??'normal'})`,t=>
  withDiagnostics(`strict-immediate-resume/${phase??'normal'}`,async d=>{
    const {afterResume:r,entry,finish}=await resumedHandover(t,d,phase,true);
    assert.equal(r.q.targetAttempt,undefined);assert.equal(r.q.delivery,undefined);
    assert.deepEqual(r.records.map(m=>m.targetAttempt),entry.map(m=>m.targetAttempt));
    if(!phase)assert.equal(r.task.sessionId,S3);
    else assert.ok(r.task.mappingPendingSince);
    await finish();
  }));
