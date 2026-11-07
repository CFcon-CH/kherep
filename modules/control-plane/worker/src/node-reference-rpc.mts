import type { BlockerCode } from "../../protocol-diagnostics.mts";
import { BINDING_PENDING_LIMIT, BINDING_TTL_MS, isResolveRequest, isResolveResponse, type ResolveRequest, type ResolveResponse } from "../../protocol-message-binding.mts";

// The Registry stamps expiresAt on its own clock; a NodeSession clock behind it must not refuse a fresh request.
const CLOCK_ALLOWANCE_MS = 30_000;
interface Pending { socket: WebSocket; token: string; request: ResolveRequest;
  resolve: (value: ResolveResponse | null) => void; timer: ReturnType<typeof setTimeout> }
export class NodeReferenceRpc {
  private readonly pending = new Map<string, Pending>();
  request(socket: WebSocket, token: string, request: ResolveRequest,
    send: () => void, current: () => boolean, failed: (code: BlockerCode) => void = () => {}): Promise<ResolveResponse | null> {
    const refusal = this.refusal(request, current);
    if (refusal) {
      try { failed(refusal); } catch { /* observation only */ }
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      const finish = (value: ResolveResponse | null, code: BlockerCode = "resolution-unavailable"): void => {
        const p = this.pending.get(request.requestId);
        if (!p) return;
        clearTimeout(p.timer); this.pending.delete(request.requestId);
        const answer = current() ? value : null;
        if (!answer) try { failed(code); } catch { /* observation only */ }
        resolve(answer);
      };
      const timer = setTimeout(() => finish(null, "resolution-timeout"), Math.min(request.expiresAt - Date.now(), BINDING_TTL_MS));
      this.pending.set(request.requestId, { socket, token, request, resolve: finish, timer });
      try { if (current()) send(); else finish(null); } catch { finish(null); }
    });
  }
  private refusal(request: ResolveRequest, current: () => boolean): BlockerCode | null {
    if (this.pending.size >= BINDING_PENDING_LIMIT) return "resolution-capacity";
    if (!isResolveRequest(request) || this.pending.has(request.requestId) || !current()) return "resolution-unavailable";
    const now = Date.now();
    return request.expiresAt <= now || request.expiresAt > now + BINDING_TTL_MS + CLOCK_ALLOWANCE_MS ? "resolution-clock" : null;
  }
  receive(socket: WebSocket, token: string, value: unknown): boolean {
    if (!isResolveResponse(value)) return false;
    const p = this.pending.get(value.requestId);
    if (!p || p.socket !== socket || p.token !== token || p.request.messageId !== value.messageId
      || p.request.expiresAt <= Date.now() || value.results.length !== p.request.selections.length
      || value.results.some(r => !p.request.selections.some(s => s.role === r.role))) return false;
    p.resolve(value); return true;
  }
  clear(socket?: WebSocket): void {
    for (const p of [...this.pending.values()]) if (!socket || socket === p.socket) p.resolve(null);
  }
}
