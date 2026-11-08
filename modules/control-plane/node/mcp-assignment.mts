import { codexHome } from "./codex-app.mts";
import { fullSessionId } from "../protocol-session-identity.mts";
import { isMcpAssignment, type McpAssignmentNative } from "../protocol-mcp.mts";
import { readLeadDirective } from "./codex-lead-directive.mts";
import type { SelfAssignmentSlot } from "../protocol-mcp.mts";

export interface AssignmentContext { slot: SelfAssignmentSlot; turnId: string; callId: string; requestId: string }
const witnesses = new WeakMap<McpAssignmentNative, string>();
export const assignmentWitness = (native: McpAssignmentNative): string | null => witnesses.get(native) ?? null;

// Local enrolled-node producer only. Never accept identity/title from queue JSON.
export async function nativeMcpAssignment(sessionId: string, context?: AssignmentContext): Promise<McpAssignmentNative | null> {
  if (process.platform !== "darwin" || !fullSessionId(sessionId)) return null;
  return readNativeMcpAssignment(codexHome(), sessionId, context);
}

// Explicit local fixture seam, never a tool argument or writable queue field.
export async function readNativeMcpAssignment(home: string, sessionId: string, context?: AssignmentContext): Promise<McpAssignmentNative | null> {
  if (!fullSessionId(sessionId)) return null;
  try {
    const { codexAssignmentRollout } = await import("./codex-app.mts");
    const lead = context?.slot === "kherep-lead";
    const witness = lead ? readLeadDirective(home, sessionId, context.turnId) : null;
    if (lead ? !witness : codexAssignmentRollout(home, sessionId) !== "ok") return null;
    const { codexAssignmentTitle } = await import("./codex-titles.mts");
    const chatName = await codexAssignmentTitle(home, sessionId);
    if (chatName === null) return null;
    if (lead && readLeadDirective(home, sessionId, context.turnId) !== witness) return null;
    const native: McpAssignmentNative = { sessionId, chatName, platform: "darwin", originalMain: true, ...(lead ? { leadGuardVersion: 1 as const } : {}) };
    if (!isMcpAssignment({ slot: context?.slot ?? "codex-mac", turnId: "native-adapter", native }, sessionId)) return null;
    if (witness) witnesses.set(native, witness);
    return native;
  } catch { return null; }
}
