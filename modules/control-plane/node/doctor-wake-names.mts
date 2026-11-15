import { fullSessionId } from "../protocol-session-identity.mts";
import type { NodePaths } from "./config.mts";
import type { NodePolicy } from "./policy.mts";
import { readBindingView } from "./session-labels.mts";

// Issue #828: for each name in wake.sessions, whether it is bound to a session id.
// A bound name follows its id through renames; an unbound name can be taken by
// whichever session holds it at the next complete listing. Exact ids and "*"
// name no session by label and are not listed. Read-only display data.
export interface WakeName {
  token: string;
  status: "bound" | "unbound" | "no-holder" | "history-unavailable";
  sessionId?: string;
  runtime?: string;
  name?: string;
  previousName?: string;
}
export interface WakeNamesCheck { ok: boolean; status: string; names: WakeName[]; detail?: string; [field: string]: unknown }

const UNAVAILABLE = "label history is unavailable, so wake names are denied until a complete listing rebuilds it; exact ids still work";
const UNBOUND = "an unbound wake name has a holder but no binding yet: it pins at the next complete listing with a unique holder";

export function checkWakeNames(paths: NodePaths, policy: NodePolicy | null): WakeNamesCheck {
  if (!policy) return { ok: false, status: "unknown", names: [], detail: "wake names are unknown because policy is unreadable" };
  if (!policy.wake) return { ok: true, status: "disabled", names: [] };
  const tokens = [...new Set(policy.wake.sessions)].filter(token => token !== "*" && !fullSessionId(token));
  const view = readBindingView(paths);
  if (view.status !== "healthy")
    return { ok: true, status: view.status, names: tokens.map(token => ({ token, status: "history-unavailable" })), detail: UNAVAILABLE };
  const names = tokens.map((token): WakeName => {
    const binding = view.bindings.find(b => b.token === token);
    if (!binding) {
      const held = view.local.some(r => r.name === token && r.current !== false && r.runtime === "claude-code");
      return { token, status: held ? "unbound" : "no-holder" };
    }
    const label = view.local.find(r => r.sessionId === binding.sessionId && r.runtime === binding.runtime);
    return { token, status: "bound", sessionId: binding.sessionId, runtime: binding.runtime,
      ...(label ? { name: label.name } : {}), ...(label?.previousName ? { previousName: label.previousName } : {}) };
  });
  return { ok: true, status: "healthy", names, ...(names.some(n => n.status === "unbound") ? { detail: UNBOUND } : {}) };
}
