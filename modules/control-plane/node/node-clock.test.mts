import assert from "node:assert/strict";
import test from "node:test";
import { createIntakeDiagnostics } from "./intake-diagnostics.mts";
import { createConnectionSupervisor } from "./connection-supervisor.mts";
import { nodeClock } from "./node-clock.mts";

test("native retry remains referenced after socket retirement; diagnostic sampling is unreferenced", () => {
  const timers: NodeJS.Timeout[] = [];
  const clock = { ...nodeClock, schedule: (run: () => void, ms: number): NodeJS.Timeout => {
    const timer = nodeClock.schedule(run, ms) as NodeJS.Timeout; timers.push(timer); return timer;
  } };
  const supervisor = createConnectionSupervisor({ clock, connect: () => assert.fail("no real wait"), reset: () => {},
    disconnected: () => {}, finish: () => {}, delay: () => 60_000, log: () => {} });
  const diagnostics = createIntakeDiagnostics({ clock, log: () => {}, pending: () => false });
  try {
    assert.equal(timers[0].hasRef(), false);
    supervisor.begin(() => {}).retireConnection({ code: 1006 });
    assert.equal(timers[1].hasRef(), true, "reconnect cannot disappear when the old socket closes");
    assert.ok(nodeClock.now() >= 0);
  } finally { supervisor.stop(); diagnostics.stop(); }
});
