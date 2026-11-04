import { env } from "cloudflare:workers";
import { inject } from "vitest";
import { isObject, MAX_BYTES, type Command, type Role, type Runtime, type Reply, type CliResult } from "./session-node-protocol.mts";
declare global { namespace Cloudflare { interface Env { NODE_HARNESS: Fetcher } } }
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(label)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
export class SessionNodeCase {
  private id = 0;
  private caseId: string | null = null;
  private sockets: SessionSocket[] = [];
  private terminal: unknown;
  private constructor() {}
  static async create(runtime: Runtime): Promise<SessionNodeCase> {
    const instance = new SessionNodeCase();
    const result = await instance.request<{ caseId: string }>({ op: "create", runtime });
    instance.caseId = result.caseId;
    return instance;
  }
  private async request<T>(command: Command): Promise<T> {
    if (this.terminal && command.op !== "close") throw this.terminal;
    const id = ++this.id;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), command.op === "create" ? 10_000 : 5000);
    try {
      const response = await env.NODE_HARNESS.fetch("http://harness.invalid/v1", {
        method: "POST", headers: { "content-type": "application/json", "x-test-token": inject("nodeHarnessToken") },
        body: JSON.stringify({ version: 1, id, caseId: this.caseId, command }), signal: controller.signal,
      });
      const raw = await response.text(); if (raw.length > MAX_BYTES) throw Error("harness response bound");
      const result: unknown = JSON.parse(raw);
      if (!isObject(result)) throw Error("invalid harness response");
      if (!response.ok || result.error) throw Error("native harness operation failed", { cause: result.error });
      const reply = result as unknown as Reply;
      if (reply.version !== 1 || reply.id !== id) throw Error("uncorrelated harness response");
      return reply.result as T;
    } catch (error) { this.terminal ??= error; throw error; }
    finally { clearTimeout(timer); }
  }
  identity(role: Role) { return this.request<{ publicKey: string }>({ op: "identity", role }); }
  attach(role: Role, nodeId: string, name: string) { return this.request({ op: "attach", role, nodeId, name }); }
  state<T>(role: Role, kind: "authenticated" | "directory" | "message" | "sent" | "receipt", messageId?: string): Promise<T> {
    return this.request<T>({ op: "state", role, kind, ...(messageId ? { messageId } : {}) });
  }
  cli(command: Extract<Command, { op: "cli" }>) { return this.request<CliResult>(command); }
  hook(event: "UserPromptSubmit" | "Stop", continued = false) { return this.request<string>({ op: "hook", event, continued }); }
  connect(role: Role, ws: WebSocket): SessionSocket {
    const socket = new SessionSocket(ws, command => this.request(command), role);
    this.sockets.push(socket);
    socket.accept();
    return socket;
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled(this.sockets.map(socket => socket.close()));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason as unknown);
    try { await this.request({ op: "close" }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "native case cleanup failed");
  }
}
export class SessionSocket {
  private chain: Promise<unknown> = Promise.resolve();
  private fatal: unknown;
  private closing = false;
  private closed = false;
  private closeResolve!: () => void;
  private closeEvent = new Promise<void>(resolve => { this.closeResolve = resolve; });
  constructor(privateSocket: WebSocket, privateRequest: <T>(command: Command) => Promise<T>, role: Role) {
    this.ws = privateSocket; this.request = privateRequest; this.role = role;
    this.ws.addEventListener("close", () => { this.closed = true; this.closeResolve(); });
    this.ws.addEventListener("error", () => { if (!this.closing) this.fatal = Error(`native ${role} socket error`); });
    this.ws.addEventListener("message", event => {
      if (this.closing) return;
      if (typeof event.data !== "string") { this.fatal = Error("non-string protocol frame"); return; }
      void this.enqueue({ op: "frame", role, frame: event.data }).catch(error => { this.fatal = error; });
    });
  }
  private ws: WebSocket;
  private request: <T>(command: Command) => Promise<T>;
  private role: Role;
  accept(): void { this.ws.accept(); }
  private enqueue(command: Command): Promise<unknown> {
    this.chain = this.chain.then(async () => {
      if (this.fatal) throw this.fatal;
      const result = await this.request<{ frames: string[] }>(command);
      if (!Array.isArray(result.frames) || result.frames.some(frame => typeof frame !== "string")) throw Error("invalid native frame result");
      for (const frame of result.frames) this.ws.send(frame);
    });
    return this.chain;
  }
  async exchange(): Promise<void> { await this.enqueue({ op: "exchange", role: this.role }); await new Promise(resolve => setTimeout(resolve, 150)); }
  async idle(): Promise<void> { await this.chain; if (this.fatal) throw this.fatal; }
  async close(): Promise<void> {
    const errors: unknown[] = [];
    try { await bounded(this.idle(), 1000, "native socket idle deadline"); } catch (error) { errors.push(error); }
    this.closing = true;
    try { if (this.ws.readyState < 2) this.ws.close(1000, "done"); } catch (error) { errors.push(error); }
    try { if (!this.closed) await bounded(this.closeEvent, 2000, "native socket CLOSE deadline"); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "native socket cleanup failed");
  }
}
