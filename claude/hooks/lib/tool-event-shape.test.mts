import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyToolEvent, codexShapeGuard, warningText, warningDocument, parseShapeWarning, type ShapeReason } from "./tool-event-shape.mts";

test("closed warning catalogue is exact, bounded and rejects forged transport", () => {
  for (const guard of ["commit-guard", "deploy-guard"] as const) {
    for (const reason of ["EVENT_ENVELOPE_INVALID", "TOOL_NAME_MISSING", "TOOL_NAME_INVALID", "TOOL_INPUT_MISSING", "TOOL_INPUT_INVALID", "COMMAND_MISSING", "COMMAND_INVALID"] as ShapeReason[]) {
      const warning = { guard, reason };
      const doc = warningDocument([warning]);
      assert.deepEqual(parseShapeWarning(doc, guard), [warning]);
      assert.equal(warningDocument([warning, warning]), doc);
      assert.equal(parseShapeWarning(doc, guard === "commit-guard" ? "deploy-guard" : "commit-guard"), undefined);
      for (const forged of [doc + "{}", doc.replace("Required tool", "SYNTHETIC_PRIVATE tool"),
        doc.replace('"hookSpecificOutput":', '"extra":true,"hookSpecificOutput":'),
        doc.replace('"hookEventName":', '"hookEventName":"PostToolUse","hookEventName":'),
        doc.replace('"additionalContext":', '"systemMessage":"x","additionalContext":'),
        JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warningText(guard, reason) + "\n" + warningText(guard, reason) } })])
        assert.equal(parseShapeWarning(forged, guard), undefined);
    }
  }
  assert.equal(parseShapeWarning("[]", "commit-guard"), undefined);
  assert.equal(parseShapeWarning("{broken", "commit-guard"), undefined);
  assert.equal(warningDocument([]), "");
  const both = warningDocument([{ guard: "deploy-guard", reason: "COMMAND_MISSING" }, { guard: "commit-guard", reason: "COMMAND_INVALID" }]);
  assert.ok(both.indexOf("commit-guard") < both.indexOf("deploy-guard"));
});

test("classification ignores optional metadata and never guesses renamed fields", () => {
  assert.deepEqual(classifyToolEvent({ tool: "Bash", tool_input: { command: "synthetic" } }, "commit-guard", "shared"), { kind: "unclassifiable", reason: "TOOL_NAME_MISSING" });
  assert.deepEqual(classifyToolEvent({ tool_name: "Read" }, "deploy-guard", "shared"), { kind: "irrelevant" });
  // Issue #808: deploy-guard judges the PowerShell tool, so a PowerShell event without tool_input is seen.
  assert.deepEqual(classifyToolEvent({ tool_name: "PowerShell" }, "deploy-guard", "shared"), { kind: "unclassifiable", reason: "TOOL_INPUT_MISSING" });
  assert.deepEqual(classifyToolEvent({ tool_name: "Read", tool_input: null }, "commit-guard", "codex"), { kind: "irrelevant" });
  assert.deepEqual(classifyToolEvent({ tool_name: "Bash", tool_input: { command: "" } }, "commit-guard", "shared"), { kind: "recognized" });
  assert.deepEqual(classifyToolEvent({ tool_name: "functions.exec", tool_input: { command: null, source: "" } }, "deploy-guard", "codex"), { kind: "recognized" });
});

test("the contract table drives classification and the Codex guard lookup (issue #808)", () => {
  assert.equal(codexShapeGuard("codex-privacy-boundary-guard"), "privacy-boundary-guard");
  assert.equal(codexShapeGuard("main-checkout-guard"), "main-checkout-guard");
  assert.equal(codexShapeGuard("codex-dispatch-contract-guard"), undefined, "a row without a codex shape");
  assert.equal(codexShapeGuard("synthetic-guard"), undefined);
  assert.equal(codexShapeGuard("toString"), undefined, "an inherited key is no row");
  // A guard without a codex shape is classified by its shared row.
  assert.deepEqual(classifyToolEvent({ tool_name: "shell_command", tool_input: {} }, "secret-output-guard", "codex"), { kind: "irrelevant" });
  assert.deepEqual(classifyToolEvent({ tool_name: "mcp__synthetic__executeDestructive" }, "atlassian-destructive-guard", "shared"), { kind: "recognized" });
  assert.deepEqual(classifyToolEvent({ tool_name: "Read", tool_input: {} }, "privacy-boundary-guard", "shared"), { kind: "recognized" });
  assert.deepEqual(classifyToolEvent({ tool_name: "apply_patch", tool_input: "*** Begin Patch" }, "privacy-boundary-guard", "codex"), { kind: "recognized" });
  assert.deepEqual(classifyToolEvent({ tool_name: "mcp__synthetic__browser_navigate", tool_input: { url: 1 } }, "playwright-file-guard", "shared"),
    { kind: "unclassifiable", reason: "COMMAND_INVALID" });
  assert.deepEqual(classifyToolEvent({ tool_name: "TodoWrite" }, "playwright-file-guard", "shared"), { kind: "irrelevant" });
});
