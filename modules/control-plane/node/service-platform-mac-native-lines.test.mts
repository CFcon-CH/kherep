// Issue #906. Environment lines of `launchctl print` and rows of the process
// listing are split without two adjacent loops over the same characters, so a
// long blank run before a line break is not rescanned.
import assert from "node:assert/strict";
import test from "node:test";

import { attestMacProcessAbsence, parseLaunchctlPrint, type MacCommand } from "./service-platform-mac-native.mts";

const target = "gui/1000/org.kherep.synthetic";
// One loaded service; line is the single entry of its environment block.
const loaded = (line: string): string => [`${target} = {`, "\tpath = /synthetic/agent.plist", "\ttype = LaunchAgent",
  "\tstate = running", "\tprogram = /synthetic/node", "\targuments = {", "\t\t/synthetic/node", "\t}",
  "\tinherited environment = {", "\t}", "\tdefault environment = {", "\t}", "\tenvironment = {", line, "\t}",
  "\tpid = 12345", "}", ""].join("\n");
const listing = (stdout: string): MacCommand => () => ({ status: 0, stdout, stderr: "" });
const timed = (run: () => void): number => { const started = performance.now(); run(); return performance.now() - started; };

test("an environment line takes an empty or blank-led value and refuses a malformed key", () => {
  for (const line of ["\t\tLANG => C", "\t\tEMPTY => ", "\t\tEMPTY =>"]) assert.equal(parseLaunchctlPrint(loaded(line), target).kind, "loaded", line);
  assert.throws(() => parseLaunchctlPrint(loaded("\t\tNODE_OPTIONS => --import x"), target), /execution-affecting environment/);
  for (const line of ["\t\tA B => c", "\tA => c"]) assert.throws(() => parseLaunchctlPrint(loaded(line), target), /identity is unavailable/, line);
  const adversarial = `\t\tA =>${" ".repeat(50_000)}\rx\ry`;
  const elapsed = timed(() => assert.throws(() => parseLaunchctlPrint(loaded(adversarial), target), /identity is unavailable/));
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
});

test("a process row keeps the inner and trailing blanks of its command", () => {
  const stdout = "    1     0 /sbin/launchd\n  502   501 /usr/bin/node  --flag x \n";
  assert.throws(() => attestMacProcessAbsence(listing(stdout), ["/usr/bin/node  --flag x "]), /remains without a loaded LaunchAgent/);
  assert.doesNotThrow(() => attestMacProcessAbsence(listing(stdout), ["/usr/bin/node"]));
  assert.doesNotThrow(() => attestMacProcessAbsence(listing(" 1 2  \n"), ["/usr/bin/node"]));
  for (const row of ["1 2 \n", "0 1 x\n", "1 x y\n"]) {
    assert.throws(() => attestMacProcessAbsence(listing(row), ["/usr/bin/node"]), /inventory is unavailable/, JSON.stringify(row));
  }
  const elapsed = timed(() => assert.throws(() => attestMacProcessAbsence(listing(`1 2${" ".repeat(50_000)}\rx\ry`), ["x"]),
    /inventory is unavailable/));
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
});
