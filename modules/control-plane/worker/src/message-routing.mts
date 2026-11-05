import { blockerDiagnostic } from "../../protocol-diagnostics.mts";
import { registryStub, sessionStub, type Env } from "./env.mts";
import type { MessageEffects } from "./message-store.mts";

// The node the caller already holds a socket for. Frames for it go out on
// that socket instead of through a call back into the same object.
export interface LocalNode { nodeId: string; send(type: "message.deliver" | "message.status", body: Record<string, unknown>, observational?: boolean): boolean;
  scheduleRetry?(): Promise<void> }

// Pushes the frames a Registry message call produced to the nodes concerned.
// A node that is not connected gets nothing now: queued messages are flushed
// again on its next authentication; sender statuses replay there in bounded cursor pages.
export async function routeEffects(env: Env, effects: MessageEffects, local?: LocalNode, phase?: "auth" | "registration"): Promise<void> {
  const frames = [
    ...effects.deliveries.map((d) => ({ nodeId: d.nodeId, type: "message.deliver" as const, body: { ...d.body } })),
    ...effects.statuses.map((s) => ({ nodeId: s.nodeId, type: "message.status" as const, body: { ...s.body }, observational: s.observational === true })),
  ];
  for (const frame of frames) {
    if (frame.type === "message.deliver") {
      if (local?.nodeId === frame.nodeId) {
        await local.scheduleRetry?.();
        const body = await registryStub(env).prepareMessageDelivery(String(frame.body.messageId), phase);
        if (body && local.send("message.deliver", { ...body })) {
          try {
            const observed = await registryStub(env).observeMessageDiagnostic(String(frame.body.messageId), frame.nodeId,
              blockerDiagnostic("acceptance-unconfirmed", Date.now(), "upstream-egress"));
            await routeEffects(env, observed, local);
          } catch { /* Observation failure cannot change a pushed frame. */ }
        }
      } else await sessionStub(env, frame.nodeId).pushFrame(frame.type, frame.body);
      continue;
    }
    if (local && local.nodeId === frame.nodeId) {
      // Issue #408 (design r3 section 4.3): a proxy refused since its effect was produced is dropped here.

      local.send(frame.type, frame.body, frame.observational);
    } else await sessionStub(env, frame.nodeId).pushFrame(frame.type, frame.body, frame.observational);
  }
}

// A message.deliver body of a proxy answer (issue #408).
export function isProxyDelivery(type: string, body: Record<string, unknown>): boolean {
  return type === "message.deliver" && typeof body.proxyOf === "string";
}
