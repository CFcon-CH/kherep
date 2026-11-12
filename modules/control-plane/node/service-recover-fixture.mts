// #810: the shared harness of the `service recover` tests: a managed node in a chosen end state, with a start that brings
// up a fresh daemon of the installed source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { nodePaths } from "./config.mts";
import { beginServiceDrain, serviceDrainFile } from "./service-drain.mts";
import { claimServiceLaunchPermit } from "./service-launch-permit.mts";
import { readServiceReceipt, serviceRoot } from "./service-records.mts";
import { recoverEvidence } from "./service-recover.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import type { ServiceBinding } from "./service-types.mts";

export type Harness = ReturnType<typeof setup>;
const NEW_PID = 42;

// The installed definition restarts as a fresh daemon of the receipt's source (the fixture's own start reuses pid 41).
export function harness(t: test.TestContext, options: { running: boolean; daemonAlive: boolean; drain: "none" | "stale" | "active" | "unknown";
  disconnected?: boolean }): Harness & { startFails: () => void } {
  const h = setup(t);
  seedManaged(h);
  let startFails = false;
  h.adapter.snapshot!.running = options.running;
  if (!options.running) delete h.adapter.snapshot!.pid;
  h.adapter.oldPidAlive = options.daemonAlive;
  h.adapter.candidatePidAlive = false;
  if (options.disconnected) h.adapter.state = { ...h.adapter.state!, disconnectedAt: "2026-10-14T10:30:00.000Z" };
  h.adapter.start = async (binding: ServiceBinding) => {
    assert.equal(claimServiceLaunchPermit(nodePaths(binding.configRoot), binding), true, "start receives one exact generation-bound permit");
    h.adapter.events.push("start");
    if (startFails) throw new Error("synthetic start failure");
    h.adapter.snapshot!.running = true;
    h.adapter.snapshot!.pid = NEW_PID;
    h.adapter.candidatePidAlive = true;
    h.adapter.state = { pid: NEW_PID, startedAt: "2026-10-14T11:00:00.000Z", connectedAt: "2026-10-14T11:00:01.000Z", source: h.old.source,
      service: { name: h.old.serviceName, platform: h.old.platform, taskPath: h.old.taskPath } };
  };
  if (options.drain !== "none") {
    beginServiceDrain(h.paths, h.deps.ownerProbe);
    if (options.drain === "stale") h.advanceController();
    if (options.drain === "unknown") h.setControllerState("unknown");
  }
  h.adapter.events.length = 0;
  return { ...h, startFails: () => { startFails = true; } };
}

// Every file under service/ with its bytes: nothing may change without --confirm.
export function serviceFiles(h: Harness): Record<string, string> {
  const root = serviceRoot(h.paths), files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file); else files[path.relative(root, file)] = fs.readFileSync(file, "base64");
    }
  };
  walk(root);
  return files;
}
export const evidence = (h: Harness) => recoverEvidence(h.deps, readServiceReceipt(h.paths)!);
export const drainExists = (h: Harness) => fs.existsSync(serviceDrainFile(h.paths));
export const permitExists = (h: Harness) => fs.existsSync(path.join(serviceRoot(h.paths), "launch-permit.json"));
export const effects = (h: Harness) => h.adapter.events.filter(event => /^(stop|start|write|remove)/.test(event));
