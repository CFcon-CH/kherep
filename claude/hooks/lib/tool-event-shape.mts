// Observational: these fixed diagnostics never grant a permission (issue #808).
import { TOOL_EVENT_CONTRACT, type ToolEventShape } from "./tool-event-contract.mts";

export type ShapeGuard = keyof typeof TOOL_EVENT_CONTRACT;
export type ShapeReason = "EVENT_ENVELOPE_INVALID" | "TOOL_NAME_MISSING" | "TOOL_NAME_INVALID"
  | "TOOL_INPUT_MISSING" | "TOOL_INPUT_INVALID" | "COMMAND_MISSING" | "COMMAND_INVALID";
export interface ShapeWarning { guard: ShapeGuard; reason: ShapeReason }
export type ShapeClassification = { kind: "irrelevant" | "recognized" } | { kind: "unclassifiable"; reason: ShapeReason };
export interface GuardEvent<T> { payload: T | null | undefined; success(): never }
const GUARDS = Object.keys(TOOL_EVENT_CONTRACT) as ShapeGuard[];
const REASONS: readonly ShapeReason[] = ["EVENT_ENVELOPE_INVALID", "TOOL_NAME_MISSING", "TOOL_NAME_INVALID",
  "TOOL_INPUT_MISSING", "TOOL_INPUT_INVALID", "COMMAND_MISSING", "COMMAND_INVALID"];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// The guard whose contract row has a native Codex shape, or undefined (installed Codex-owned
// guards carry a codex- prefix). Only those are classified by the Codex adapter.
export const codexShapeGuard = (name: string): ShapeGuard | undefined => {
  const guard = name.replace(/^codex-/, "");
  return Object.hasOwn(TOOL_EVENT_CONTRACT, guard) && "codex" in TOOL_EVENT_CONTRACT[guard as ShapeGuard] ? guard as ShapeGuard : undefined;
};

// Undefined is also the explicit parse-failure input. No raw text or unknown key is returned.
// A guard without a codex row is classified by its shared row.
export function classifyToolEvent(value: unknown, guard: ShapeGuard, dialect: "shared" | "codex"): ShapeClassification {
  const row: { shared: ToolEventShape; codex?: ToolEventShape } = TOOL_EVENT_CONTRACT[guard];
  const shape = (dialect === "codex" && row.codex) || row.shared;
  const bad = (reason: ShapeReason): ShapeClassification => ({ kind: "unclassifiable", reason });
  if (!record(value)) return bad("EVENT_ENVELOPE_INVALID");
  if (!("tool_name" in value)) return bad("TOOL_NAME_MISSING");
  const tool = value.tool_name;
  if (typeof tool !== "string" || !tool.trim()) return bad("TOOL_NAME_INVALID");
  if (!shape.tools.includes(tool) && !shape.toolPatterns?.some(pattern => new RegExp(pattern).test(tool))) return { kind: "irrelevant" };
  const keys = shape.inputKeys;
  if (!keys) return { kind: "recognized" };
  const input = value.tool_input;
  if (input === undefined || input === null) return bad("TOOL_INPUT_MISSING");
  if (shape.stringInput && typeof input === "string") return { kind: "recognized" };
  if (!record(input)) return bad("TOOL_INPUT_INVALID");
  if (!keys.length || keys.some(key => typeof input[key] === "string")) return { kind: "recognized" };
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

// A guard's quiet allow: the warning on stderr and as its whole stdout when the event
// cannot be classified, else nothing. Call it only where the guard would print nothing.
export function warnUnclassifiable(value: unknown, guard: ShapeGuard): void {
  const shape = classifyToolEvent(value, guard, "shared");
  if (shape.kind !== "unclassifiable") return;
  process.stderr.write(`${warningText(guard, shape.reason)}\n`);
  process.stdout.write(warningDocument([{ guard, reason: shape.reason }]));
}

// Shared guard lifecycle: policy checks still own every denial. Only an existing
// successful return emits this pending warning; parsing itself performs no I/O.
export async function parseGuardEvent<T>(raw: Promise<string>, guard: ShapeGuard): Promise<GuardEvent<T>> {
  let value: unknown;
  try { value = JSON.parse(await raw); } catch { /* explicit invalid envelope */ }
  return {
    payload: value as T | null | undefined,
    success(): never {
      warnUnclassifiable(value, guard);
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
