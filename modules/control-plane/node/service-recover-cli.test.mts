// #810: the `service recover` CLI: its arguments, the evidence print, --confirm and the display-only last failure.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseServiceCommand, runService } from "./service-cli.mts";
import { serviceRoot } from "./service-records.mts";
import { effects, harness, serviceFiles, type Harness } from "./service-recover-fixture.mts";
import type { ServiceAdapter } from "./service-types.mts";

async function cli(h: Harness, argv: string[]): Promise<{ exit: number; report: Record<string, unknown> }> {
  fs.writeFileSync(h.paths.config, JSON.stringify({ version: 1, nodeId: crypto.randomUUID() }));
  const { paths: _paths, adapter: _adapter, ...lifecycle } = h.deps;
  const lines: string[] = [];
  const log = console.log;
  console.log = (value: unknown) => { lines.push(String(value)); };
  try {
    const exit = await runService(argv, { root: path.dirname(h.paths.dir), adapterFor: () => h.adapter as unknown as ServiceAdapter, lifecycle });
    return { exit, report: JSON.parse(lines.join("\n")) as Record<string, unknown> };
  } finally { console.log = log; }
}

test("CLI: `service recover` prints the evidence, writes and starts nothing; `--confirm` recovers", async (t) => {
  const h = harness(t, { running: false, daemonAlive: false, drain: "stale" });
  const before = serviceFiles(h);
  const shown = await cli(h, ["recover"]);
  assert.equal(shown.exit, 0);
  assert.equal(shown.report.canRecover, true);
  assert.equal(shown.report.confirmed, false);
  assert.equal(shown.report.installed, h.old.source.commit);
  assert.deepEqual(serviceFiles(h), before);
  assert.deepEqual(effects(h), []);
  assert.equal(JSON.stringify(shown.report).includes(h.paths.dir), false, "no path");
  const done = await cli(h, ["recover", "--confirm"]);
  assert.equal(done.exit, 0);
  assert.equal(done.report.ok, true);
  assert.deepEqual(done.report.final, { running: true, node: "running", drain: "none" });
  const again = await cli(h, ["recover"]);
  assert.equal(again.exit, 1);
  assert.equal(again.report.reason, "NODE_RUNNING");
});

test("CLI: recover shows the display-only last failure and leaves the record untouched", async (t) => {
  const h = harness(t, { running: false, daemonAlive: false, drain: "stale" });
  const record = { version: 1, command: "upgrade", failedAt: "2026-11-12T08:00:00.000Z", stage: "stop", recovery: "unknown",
    stopCode: "STOP_UNPROVEN_TIMEOUT", writeAttempted: false, drainRetained: true };
  const file = path.join(serviceRoot(h.paths), "last-failure.json");
  fs.writeFileSync(file, JSON.stringify(record));
  const shown = await cli(h, ["recover"]);
  const { version: _version, ...displayed } = record;
  assert.deepEqual(shown.report.lastFailure, displayed);
  await cli(h, ["recover", "--confirm"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), record, "recover never writes or removes the record");
});

test("recover takes --confirm and nothing else; no other action takes --confirm", () => {
  assert.deepEqual(parseServiceCommand(["recover"]), { action: "recover", confirm: false });
  assert.deepEqual(parseServiceCommand(["recover", "--confirm"]), { action: "recover", confirm: true });
  for (const argv of [["recover", "--confirm", "--confirm"], ["recover", "--source", path.resolve("source")], ["recover", "--confirm=yes"],
    ["recover", "extra"], ["upgrade", "--confirm"], ["status", "--confirm"], ["rollback", "--confirm"]]) {
    assert.throws(() => parseServiceCommand(argv), /usage/, argv.join(" "));
  }
});
