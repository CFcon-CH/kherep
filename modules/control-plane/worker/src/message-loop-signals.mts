// Derived content only: never persist/return the normalized text.
export interface LoopSignal { fingerprint: string; acknowledgement: boolean }
export type LoopSigner = (domain: string, value: string) => Promise<string>;
export interface VerifiedProxy { owner: string; messageId: string }
export const normalizeLoopText = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const ACK = /^(?:(?:acknowledged|ack|okay|ok|received|understood|noted|thanks|thank you|got it|roger|verstanden|erhalten|notiert|danke|alles klar)(?:[.! ,]+|$))+$/u;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PREFIX = new RegExp(`^Kherep proxy answer: an ephemeral fork of session (${UUID}) \\(fork (${UUID})\\) answered message (${UUID}) while the owner was idle\\. The owner has not read your message yet\\.\\n\\n`);
export function isAcknowledgementOnly(text: string): boolean {
  const normalized = normalizeLoopText(text);
  return normalized === "" || ([...normalized].length <= 96 && ACK.test(normalized));
}
export async function prepareLoopSignal(text: string, sign: LoopSigner, proxy?: VerifiedProxy): Promise<LoopSignal> {
  const prefix = proxy ? PREFIX.exec(text) : null;
  const content = prefix && prefix[1] === proxy?.owner && prefix[3] === proxy.messageId ? text.slice(prefix[0].length) : text;
  const normalized = normalizeLoopText(content);
  return { fingerprint: await sign("kherep-loop-text-v1", normalized), acknowledgement: isAcknowledgementOnly(content) };
}
