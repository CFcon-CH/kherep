// Stage 1 is observational: these fixed diagnostics never grant a permission.
export type ShapeGuard = "commit-guard" | "deploy-guard";
export type ShapeReason = "EVENT_ENVELOPE_INVALID" | "TOOL_NAME_MISSING" | "TOOL_NAME_INVALID"
  | "TOOL_INPUT_MISSING" | "TOOL_INPUT_INVALID" | "COMMAND_MISSING" | "COMMAND_INVALID";
export interface ShapeWarning { guard: ShapeGuard; reason: ShapeReason }
export type ShapeClassification = { kind: "irrelevant" | "recognized" } | { kind: "unclassifiable"; reason: ShapeReason };
export interface GuardEvent<T> { payload: T | null | undefined; success(): never }
const GUARDS: readonly ShapeGuard[] = ["commit-guard", "deploy-guard"];
const REASONS: readonly ShapeReason[] = ["EVENT_ENVELOPE_INVALID", "TOOL_NAME_MISSING", "TOOL_NAME_INVALID",
  "TOOL_INPUT_MISSING", "TOOL_INPUT_INVALID", "COMMAND_MISSING", "COMMAND_INVALID"];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// Undefined is also the explicit parse-failure input. No raw text or unknown key is returned.
export function classifyToolEvent(value: unknown, guard: ShapeGuard, dialect: "shared" | "codex"): ShapeClassification {
  const bad = (reason: ShapeReason): ShapeClassification => ({ kind: "unclassifiable", reason });
  if (!record(value)) return bad("EVENT_ENVELOPE_INVALID");
  if (!("tool_name" in value)) return bad("TOOL_NAME_MISSING");
  const tool = value.tool_name;
  if (typeof tool !== "string" || !tool.trim()) return bad("TOOL_NAME_INVALID");
  const relevant = tool === "Bash" || (guard === "commit-guard" && tool === "PowerShell")
    || (dialect === "codex" && ["shell_command", "exec_command", "functions.exec"].includes(tool));
  if (!relevant) return { kind: "irrelevant" };
  const input = value.tool_input;
  if (input === undefined || input === null) return bad("TOOL_INPUT_MISSING");
  if (dialect === "codex" && typeof input === "string") return { kind: "recognized" };
  if (!record(input)) return bad("TOOL_INPUT_INVALID");
  const keys = dialect === "codex" ? ["command", "source", "code", "input", "patch"] : ["command"];
  if (keys.some(key => typeof input[key] === "string")) return { kind: "recognized" };
  return bad(keys.some(key => key in input) ? "COMMAND_INVALID" : "COMMAND_MISSING");
}

export const warningText = (guard: ShapeGuard, reason: ShapeReason): string =>
  `[kherep:event-shape:WARN:${guard}:${reason}] Required tool event fields could not be classified; this warning does not change the permission decision.`;

export function warningDocument(warnings: readonly ShapeWarning[]): string {
  const lines = GUARDS.flatMap(guard => {
    const warning = warnings.find(item => item.guard === guard);
    return warning ? [warningText(guard, warning.reason)] : [];
  });
  return lines.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: lines.join("\n") } }) : "";
}

// Shared guard lifecycle: policy checks still own every denial. Only an existing
// successful return emits this pending warning; parsing itself performs no I/O.
export async function parseGuardEvent<T>(raw: Promise<string>, guard: ShapeGuard): Promise<GuardEvent<T>> {
  let value: unknown;
  try { value = JSON.parse(await raw); } catch { /* explicit invalid envelope */ }
  const shape = classifyToolEvent(value, guard, "shared");
  return {
    payload: value as T | null | undefined,
    success(): never {
      if (shape.kind === "unclassifiable") {
        process.stderr.write(`${warningText(guard, shape.reason)}\n`);
        process.stdout.write(warningDocument([{ guard, reason: shape.reason }]));
      }
      process.exit(0);
    },
  };
}

// Compare the complete canonical serialization, including key order, to reject duplicate
// JSON keys, extras and forged prefixes. Admission is limited to the expected guard slot.
export function parseShapeWarning(stdout: string, expectedGuard: ShapeGuard): ShapeWarning[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!record(parsed) || !record(parsed.hookSpecificOutput)) return undefined;
    const text = parsed.hookSpecificOutput.additionalContext;
    const reason = REASONS.find(reason => text === warningText(expectedGuard, reason));
    if (!reason) return undefined;
    const warnings = [{ guard: expectedGuard, reason }];
    return stdout === warningDocument(warnings) ? warnings : undefined;
  } catch { return undefined; }
}
