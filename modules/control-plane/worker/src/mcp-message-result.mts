import type { SendResult } from "./message-store.mts";
import type { McpRegistry } from "./mcp-registry.mts";

type SuccessfulClaim = Extract<ReturnType<McpRegistry["claim"]>, { ok: true }>;
export type McpSendResult =
  | (Extract<SendResult, { ok: true }> & { denied: false; claim?: SuccessfulClaim })
  | { ok: false; denied: true; error: string }
  | (Extract<SendResult, { ok: false }> & { denied?: false });
export type McpReplyResult = McpSendResult | { ok: false; denied: false; lookup: string };

// Shape normalization only: authorization, effects and storage remain with the caller.
export function asMcpSendResult(result: SendResult): McpSendResult {
  return { ...result, denied: false };
}
