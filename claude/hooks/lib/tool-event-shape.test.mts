import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyToolEvent, warningText, warningDocument, parseShapeWarning, type ShapeReason } from "./tool-event-shape.mts";

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
  assert.deepEqual(classifyToolEvent({ tool_name: "PowerShell" }, "deploy-guard", "shared"), { kind: "irrelevant" });
  assert.deepEqual(classifyToolEvent({ tool_name: "Read", tool_input: null }, "commit-guard", "codex"), { kind: "irrelevant" });
  assert.deepEqual(classifyToolEvent({ tool_name: "Bash", tool_input: { command: "" } }, "commit-guard", "shared"), { kind: "recognized" });
  assert.deepEqual(classifyToolEvent({ tool_name: "functions.exec", tool_input: { command: null, source: "" } }, "deploy-guard", "codex"), { kind: "recognized" });
});
