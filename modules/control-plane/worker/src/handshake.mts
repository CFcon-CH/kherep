import { CLOCK_SKEW_MS, isAuthBody, NONCE_TTL_MS, type Envelope } from "../../protocol.mts";
import { verifyChallenge } from "./crypto.mts";

// Per-connection state, kept with ws.serializeAttachment() so it survives
// hibernation (max 16,384 bytes serialized).
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment
export interface Attachment {
  nodeId: string;
  authed: boolean;
  connectionToken?: string;
  registrationAccepted?: boolean;
  loopCapability?: boolean;
  selectedBindingCapability?: boolean;
  nonce?: string;
  nonceIssuedAt?: number;
  connectedAt: number;
  // Highest node-to-server seq seen on this connection, for duplicate drops.
  lastNodeSeq: number;
}

// WebSocket close codes in the private-use range 4000-4999.
export const CLOSE = {
  protocol: 4400,
  badSignature: 4401,
  unknownOrRevoked: 4403,
  nonceExpired: 4408,
  replaced: 4409,
  offline: 4410,
} as const;

export type AuthVerdict = { ok: true } | { ok: false; code: number; reason: string };

// Checks one `auth` message against the challenge issued on this connection.
// The nonce is single use: it lives only in this connection's attachment and
// is dropped after the first auth attempt, successful or not, because the
// caller closes the socket on failure and rewrites the attachment on success.
export async function checkAuth(
  attachment: Attachment, envelope: Envelope, now: number, lookupKey: (nodeId: string) => Promise<string | null>,
): Promise<AuthVerdict> {
  if (envelope.type !== "auth" || !isAuthBody(envelope.body)) {
    return { ok: false, code: CLOSE.protocol, reason: "expected auth" };
  }
  const auth = envelope.body;
  if (auth.nodeId !== attachment.nodeId) return { ok: false, code: CLOSE.badSignature, reason: "node mismatch" };
  if (!attachment.nonce || auth.nonce !== attachment.nonce) return { ok: false, code: CLOSE.badSignature, reason: "nonce mismatch" };
  if (attachment.nonceIssuedAt === undefined || now - attachment.nonceIssuedAt > NONCE_TTL_MS) {
    return { ok: false, code: CLOSE.nonceExpired, reason: "nonce expired" };
  }
  if (Math.abs(now - auth.timestamp) > CLOCK_SKEW_MS) return { ok: false, code: CLOSE.nonceExpired, reason: "timestamp out of range" };
  const publicKey = await lookupKey(auth.nodeId);
  if (!publicKey) return { ok: false, code: CLOSE.unknownOrRevoked, reason: "unknown or revoked node" };
  if (!(await verifyChallenge(publicKey, auth))) return { ok: false, code: CLOSE.badSignature, reason: "bad signature" };
  return { ok: true };
}
