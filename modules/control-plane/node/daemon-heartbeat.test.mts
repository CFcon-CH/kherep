import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scenarios = ["open-timeout", "pong-timeout", "healthy", "stale", "terminal-4403", "terminal-4409", "blocked-discovery", "blocked-frame", "auth-barrier", "rejected-chain", "sleep", "stop-opening", "stop-probe", "stop-grace", "stop-retry", "pending"];
const fixture = fileURLToPath(new URL("./daemon-heartbeat-scenarios-fixture.mts", import.meta.url));
for (const item of scenarios) test(`daemon heartbeat: ${item}`, () => {
  const output = execFileSync(process.execPath, ["--experimental-test-module-mocks", fixture, item],
    { encoding: "utf8", timeout: 15_000 });
  assert.match(output, /HEARTBEAT_PASS/);
});
