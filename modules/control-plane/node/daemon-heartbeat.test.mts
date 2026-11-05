import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { writeRequest, readRequest } from "./task-records.mts";
import { makeEnvelope } from "../protocol.mts";
import { heartbeatFixture, PING_FRAME, PONG_FRAME, flush } from "./daemon-heartbeat-fixture.mts";

const scenarios = ["open-timeout", "pong-timeout", "healthy", "stale", "terminal-4403", "terminal-4409", "blocked-discovery", "blocked-frame", "auth-barrier", "sleep", "stop-opening", "stop-probe", "stop-grace", "stop-retry", "pending"];
const scenario = process.argv[2];
if (!scenario) {
  for (const item of scenarios) test(`daemon heartbeat: ${item}`, () => {
    const output = execFileSync(process.execPath, ["--experimental-test-module-mocks", import.meta.filename, item],
      { encoding: "utf8", timeout: 15_000 });
    assert.match(output, /HEARTBEAT_PASS/);
  });
} else {
  assert.ok(scenarios.includes(scenario));
  const f = await heartbeatFixture();
  try {
    const old = f.sockets[0];
    const timeouts = (): string[] => f.logs.filter(line => line.startsWith("PONG_TIMEOUT") || line.startsWith("OPEN_TIMEOUT"));
    if (scenario !== "open-timeout" && scenario !== "stop-opening") old.open();
    if (scenario === "open-timeout" || scenario === "pong-timeout") {
      const deadline = scenario === "open-timeout" ? 30_000 : 50_000;
      f.clock.advance(deadline - 1); assert.equal(f.sockets.length, 1); assert.equal(timeouts().length, 0);
      f.clock.advance(1); assert.equal(old.closes, 1); assert.equal(timeouts().length, 1);
      assert.match(timeouts()[0], /^(OPEN|PONG)_TIMEOUT open_ms=\d+ pong_age_ms=\d+ delay_ms=\d+$/);
      f.clock.advance(500); assert.equal(f.sockets.length, 2);
      old.emit("close", { code: 1006 }); f.clock.advance(1_000); assert.equal(f.sockets.length, 2);
    } else if (scenario === "healthy") {
      for (let n = 0; n < 5; n++) {
        f.clock.advance(29_999); old.receive(PONG_FRAME); await flush();
      }
      assert.equal(f.sockets.length, 1); assert.deepEqual(timeouts(), []);
      old.receive({ binary: true }); assert.equal(f.sockets.length, 1);
    } else if (scenario === "stale") {
      f.clock.advance(50_500); const fresh = f.sockets[1]; fresh.open(); f.auth(fresh); await flush();
      const state = fs.readFileSync(`${f.paths.dir}/daemon.json`, "utf8"), sent = fresh.sent.length;
      old.open(); old.receive(PONG_FRAME); f.auth(old); old.emit("error");
      old.emit("close", { code: 1006 }); old.emit("close", { code: 4409 }); await flush();
      assert.equal(fs.readFileSync(`${f.paths.dir}/daemon.json`, "utf8"), state);
      assert.equal(fresh.sent.length, sent); assert.equal(f.sockets.length, 2);
      f.clock.advance(45_000); assert.equal(fresh.sent.at(-1), PING_FRAME);
      fresh.receive(PONG_FRAME); await flush(); assert.deepEqual(timeouts().length, 1);
    } else if (scenario.startsWith("terminal-")) {
      old.emit("close", { code: Number(scenario.slice(9)) }); await f.handle.done;
      f.clock.advance(1_000_000); assert.equal(f.sockets.length, 1); assert.equal(timeouts().length, 0);
    } else if (scenario === "blocked-discovery") {
      f.blockDiscovery(); f.auth(); await flush();
      assert.equal(f.discoverySignal()?.aborted, false);
      f.clock.advance(45_000); old.receive(PONG_FRAME); f.clock.advance(30_000);
      assert.equal(timeouts().length, 0); assert.equal(f.sockets.length, 1);
      f.clock.advance(50_500); assert.equal(f.sockets.length, 2);
      assert.equal(f.discoverySignal()?.aborted, true); f.releaseDiscovery(); await flush();
    } else if (scenario === "blocked-frame") {
      f.blockRuntime(); f.auth(); await flush();
      f.clock.advance(45_000); old.receive(PONG_FRAME); await flush();
      f.clock.advance(30_000); assert.equal(f.sockets.length, 1);
      f.clock.advance(50_500); const fresh = f.sockets[1]; fresh.open(); f.auth(fresh);
      f.releaseRuntime(); await flush();
      assert.ok(fresh.sent.some(raw => raw.includes('"register"')));
      assert.equal(old.sent.filter(raw => raw !== PING_FRAME).length, 0, "stale awaited auth sends nothing");
    } else if (scenario === "auth-barrier") {
      f.blockRuntime(); f.auth(); await flush();
      f.clock.advance(50_500); const fresh = f.sockets[1]; fresh.open();
      fs.writeFileSync(f.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], messaging: { accept: [{ from: ["*"], session: "*" }] } }));
      f.auth(fresh);
      fresh.receive(JSON.stringify(makeEnvelope("message.deliver", { messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        from: { nodeId: "ffffffff-ffff-4fff-8fff-ffffffffffff", session: "source" }, toSession: "synthetic", text: "synthetic", createdAt: new Date(0).toISOString() }, 0, 0)));
      await flush(); assert.equal(fresh.sent.some(raw => raw.includes('"message.status"')), false, "new delivery waits for its own auth");
      f.releaseRuntime(); await flush();
      assert.ok(fresh.sent.some(raw => raw.includes('"state":"accepted"')), "delivery progresses after current auth");
    } else if (scenario === "sleep") {
      f.clock.time = 900_000;
      while (f.clock.fire() && old.sent.length < 2) { /* diagnostics may fire first */ }
      assert.equal(old.sent.at(-1), PING_FRAME); assert.equal(timeouts().length, 0);
      old.receive(PONG_FRAME); f.clock.advance(5_000); assert.equal(timeouts().length, 0);
    } else if (scenario === "pending") {
      // A completed task's connection-lifetime dedup set is not pending evidence.
      f.auth(); await flush();
      fs.writeFileSync(f.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: false }, sessions: { delegate: { request: true } } }));
      const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      writeRequest(f.paths, { requestId, title: "synthetic", text: "synthetic", requirements: {}, directive: "synthetic",
        requestedBy: "synthetic", createdAt: new Date(0).toISOString(), state: "pending" });
      f.intervals.get(2_000)!(); await flush();
      assert.ok(old.sent.some(raw => raw.includes('"task.request"')));
      old.receive(JSON.stringify(makeEnvelope("event", { name: "task.request.result", requestId, ok: true }, 0, 0))); await flush();
      assert.equal(readRequest(f.paths, requestId)?.state, "dispatched");
      for (let n = 0; n < 90; n++) { old.receive(PONG_FRAME); f.clock.advance(1_000); }
      assert.equal(f.logs.filter(line => line.startsWith("INTAKE_DIAG code=3")).length, 0);
    } else {
      if (scenario === "stop-grace") f.clock.advance(45_000);
      if (scenario === "stop-retry") f.clock.advance(50_000);
      const count = f.sockets.length; f.handle.stop(); await f.handle.done;
      f.clock.advance(1_000_000); assert.equal(f.sockets.length, count); assert.equal(f.clock.timers.size, 0);
    }
    console.log(`HEARTBEAT_PASS ${scenario}`);
  } finally { await f.close(); }
}
