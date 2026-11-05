import type { BlockerCode } from "../../protocol-diagnostics.mts";
import { BINDING_PENDING_LIMIT, BINDING_TTL_MS, isResolveRequest, isResolveResponse, type ResolveRequest, type ResolveResponse } from "../../protocol-message-binding.mts";

interface Pending { socket: WebSocket; token: string; request: ResolveRequest;
  resolve: (value: ResolveResponse | null) => void; timer: ReturnType<typeof setTimeout> }
export class NodeReferenceRpc {
  private readonly pending = new Map<string, Pending>();
  request(socket: WebSocket, token: string, request: ResolveRequest,
    send: () => void, current: () => boolean, failed: (code: BlockerCode) => void = () => {}): Promise<ResolveResponse | null> {
    if (!isResolveRequest(request) || this.pending.has(request.requestId) || this.pending.size >= BINDING_PENDING_LIMIT
      || request.expiresAt <= Date.now() || request.expiresAt > Date.now() + BINDING_TTL_MS || !current()) {
      try { failed(this.pending.size >= BINDING_PENDING_LIMIT ? "resolution-capacity" : "resolution-unavailable"); } catch { /* observation only */ }
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
      const timer = setTimeout(() => finish(null, "resolution-timeout"), request.expiresAt - Date.now());
      this.pending.set(request.requestId, { socket, token, request, resolve: finish, timer });
      try { if (current()) send(); else finish(null); } catch { finish(null); }
    });
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
