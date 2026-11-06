import { fullSessionId } from "../protocol-session-identity.mts";
export const LABEL_FRESH_MS = 180000;
export interface LabelRow {
    nodeId: string;
    runtime: string;
    sessionId: string;
    name: string;
    observedAt: number;
    lifecycleGeneration: number;
    revision: number;
    current?: boolean;
}
export interface NameBinding {
    token: string;
    runtime: string;
    sessionId: string;
    firstName: string;
    boundAt: number;
    sourceGeneration: number;
    provenance: "policy-co-list";
}
export interface IdentityVeto {
    runtime: string;
    sessionId: string;
    kind: "conflict" | "terminal";
    sourceGeneration: number;
    observedAt: number;
    lifecycleGeneration: number;
}
export interface BindingView {
    status: "healthy" | "history-unavailable";
    version: number;
    bindings: NameBinding[];
    local: LabelRow[];
    complete: boolean;
    observedAt: number;
    ambiguousNames?: string[];
    identityVetoes?: IdentityVeto[];
}
export interface WakeSelection {
    allowed: boolean;
    explicit: boolean;
    reason: "id" | "wildcard" | "bound-name" | "unbound-name" | "not-listed" | "history-unavailable" | "identity-conflict";
}
export interface WakeBindingContext {
    target: {
        runtime: string;
        sessionId: string;
    };
    view: BindingView;
    now: number;
}
// Pure selection only: persistence, first binding and delivery aliases belong to other seams.
export function resolveWakeSelection(tokens: readonly string[], { target, view, now }: WakeBindingContext): WakeSelection {
    const result = (explicit: boolean, reason: WakeSelection["reason"]): WakeSelection => ({ allowed: explicit || tokens.includes("*"), explicit, reason: !explicit && tokens.includes("*") ? "wildcard" : reason });
    if (fullSessionId(target.sessionId) && tokens.includes(target.sessionId))
        return result(true, "id");
    if (view.status !== "healthy")
        return result(false, "history-unavailable");
    if (!fullSessionId(target.sessionId))
        return result(false, "not-listed");
    const exact = view.local.filter(r => r.sessionId === target.sessionId && r.current !== false);
    if ((view.identityVetoes ?? []).some(v => v.runtime === target.runtime && v.sessionId === target.sessionId)
        || exact.length > 1 || exact.some(r => r.runtime !== target.runtime))
        return result(false, "identity-conflict");
    for (const token of tokens) {
        if (token === "*" || fullSessionId(token))
            continue;
        const binding = view.bindings.find(b => b.token === token);
        if (binding) {
            if (binding.sessionId === target.sessionId && binding.runtime === target.runtime)
                return result(true, "bound-name");
            continue;
        }
        const matches = view.local.filter(r => r.name === token && r.current !== false);
        if (exact.length === 1 && !(view.ambiguousNames ?? []).includes(token) && view.complete && view.observedAt <= now && now - view.observedAt <= LABEL_FRESH_MS && matches.length === 1
            && matches[0].sessionId === target.sessionId && matches[0].runtime === target.runtime && matches[0].observedAt <= now && now - matches[0].observedAt <= LABEL_FRESH_MS
            && !view.local.some(r => r.sessionId === token))
            return result(true, "unbound-name");
    }
    return result(false, "not-listed");
}
