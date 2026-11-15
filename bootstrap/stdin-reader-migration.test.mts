import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readStdinBytes as canonical } from "../claude/hooks/lib/stdin-reader.mts";
import { readStdinBytes as codex } from "../codex/hooks/stdin-reader.mts";
import { readStdinBytes as controlPlane } from "../modules/control-plane/node/stdin-reader.mts";

// The reviewed 44-site scope; neither fixture readers nor indirect integrity read(0) is migrated.
const READERS = [
  "bootstrap/prepare-secrets.mts",
  "claude/hooks/atlassian-destructive-guard.mts",
  "claude/hooks/clq-accept-gate.mts",
  "claude/hooks/critical-file-integrity.mts",
  "claude/hooks/dispatch-contract-guard.mts",
  "claude/hooks/drift-check-nudge.mts",
  "claude/hooks/drift-managed-path-watch.mts",
  "claude/hooks/live-hook-integrity.mts",
  "claude/hooks/loc-watch.mts",
  "claude/hooks/maestro-banner-gate.mts",
  "claude/hooks/maestro-discipline.mts",
  "claude/hooks/manifest-watch.mts",
  "claude/hooks/obs-handback-gate.mts",
  "claude/hooks/obs-handback-record.mts",
  "claude/hooks/obs-result-check.mts",
  "claude/hooks/observation-stop.mts",
  "claude/hooks/orchestra-default.mts",
  "claude/hooks/orphan-check-nudge.mts",
  "claude/hooks/privacy-boundary-guard.mts",
  "claude/hooks/research-first.mts",
  "claude/hooks/research-stop.mts",
  "claude/hooks/runtime-capability-snapshot.mts",
  "claude/hooks/simplify-nudge.mts",
  "claude/hooks/smoke-test-nudge.mts",
  "claude/hooks/umlaut-translit-watch.mts",
  "claude/kherep/githooks/attribution-record.mts",
  "codex/hooks/acceptance-gate.mts",
  "codex/hooks/cbm-reminder.mts",
  "codex/hooks/confluence-delivery-check.mts",
  "codex/hooks/dispatch-contract-guard.mts",
  "codex/hooks/hook-adapter.mts",
  "codex/hooks/kherep-maestro-context.mts",
  "codex/hooks/obs-result-check.mts",
  "codex/hooks/observation-stop.mts",
  "codex/hooks/observation-turn-completion.mts",
  "codex/hooks/post-edit-checks.mts",
  "codex/hooks/precompact-checkpoint.mts",
  "codex/hooks/privacy-boundary-guard.mts",
  "codex/hooks/research-first.mts",
  "codex/hooks/research-stop.mts",
  "modules/control-plane/node/attribution-hook.mts",
  "modules/control-plane/node/deliver-hook.mts",
  "modules/control-plane/node/mcp-intent-hook.mts",
  "modules/control-plane/node/wake-hook.mts"
] as const;

test("all 44 reviewed production readers await explicit null-cap byte transport", () => {
  assert.equal(READERS.length, 44);
  for (const relative of READERS) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", relative), "utf8");
    assert.doesNotMatch(source, /readFileSync\(\s*(?:0|process\.stdin\.fd)(?:\s*[,)]|\s*\))/u, relative);
    assert.match(source, /await[\s\S]*readStdinBytes\(\{ maxBytes: null \}\)/u, relative);
  }
  const excluded = fs.readFileSync(path.resolve(import.meta.dirname, "../codex/hooks/hook-integrity.mts"), "utf8");
  assert.match(excluded, /read\(0\)/u, "excluded indirect reader remains a separate scope");
});

test("source siblings reexport exactly the one canonical reader", () => {
  assert.equal(codex, canonical);
  assert.equal(controlPlane, canonical);
});
