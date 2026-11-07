import { codexHome } from "./codex-app.mts";
import { fullSessionId } from "../protocol-session-identity.mts";
import { isMcpAssignment, type McpAssignmentNative } from "../protocol-mcp.mts";

// Local enrolled-node producer only. Never accept identity/title from queue JSON.
export async function nativeMcpAssignment(sessionId: string): Promise<McpAssignmentNative | null> {
  if (process.platform !== "darwin" || !fullSessionId(sessionId)) return null;
  return readNativeMcpAssignment(codexHome(), sessionId);
}

// Explicit local fixture seam, never a tool argument or writable queue field.
export async function readNativeMcpAssignment(home: string, sessionId: string): Promise<McpAssignmentNative | null> {
  if (!fullSessionId(sessionId)) return null;
  try {
    const { codexAssignmentRollout } = await import("./codex-app.mts");
    if (codexAssignmentRollout(home, sessionId) !== "ok") return null;
    const { codexAssignmentTitle } = await import("./codex-titles.mts");
    const chatName = await codexAssignmentTitle(home, sessionId);
    if (chatName === null) return null;
    const native = { sessionId, chatName, platform: "darwin" as const, originalMain: true as const };
    return isMcpAssignment({ slot: "codex-mac", turnId: "native-adapter", native }, sessionId) ? native : null;
  } catch { return null; }
}
