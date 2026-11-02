import { registryStub, sessionStub, type Env } from "./env.mts";
import type { MessageEffects } from "./message-store.mts";

// The node the caller already holds a socket for. Frames for it go out on
// that socket instead of through a call back into the same object.
export interface LocalNode { nodeId: string; send(type: "message.deliver" | "message.status", body: Record<string, unknown>): void }

// Pushes the frames a Registry message call produced to the nodes concerned.
// A node that is not connected gets nothing now: queued messages are flushed
// again on its next authentication; sender statuses replay there in bounded cursor pages.
export async function routeEffects(env: Env, effects: MessageEffects, local?: LocalNode): Promise<void> {
  const frames = [
    ...effects.deliveries.map((d) => ({ nodeId: d.nodeId, type: "message.deliver" as const, body: { ...d.body } })),
    ...effects.statuses.map((s) => ({ nodeId: s.nodeId, type: "message.status" as const, body: { ...s.body } })),
  ];
  for (const frame of frames) {
    if (local && local.nodeId === frame.nodeId) {
      // Issue #408 (design r3 section 4.3): a proxy refused since its effect was produced is dropped here.
      if (isProxyDelivery(frame.type, frame.body) && !await registryStub(env).messageQueued(String(frame.body.messageId))) continue;
      if (frame.type === "message.deliver" && frame.body.loop !== undefined && !await registryStub(env).messageDeliveryReady(String(frame.body.messageId))) continue;
      local.send(frame.type, frame.body);
    } else await sessionStub(env, frame.nodeId).pushFrame(frame.type, frame.body);
  }
}

// A message.deliver body of a proxy answer (issue #408).
export function isProxyDelivery(type: string, body: Record<string, unknown>): boolean {
  return type === "message.deliver" && typeof body.proxyOf === "string";
}
