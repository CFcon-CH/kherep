import type {} from "vitest";
// Test-only JSON boundary. No paths, modules, executables or shell commands cross it.
export type Role = "a" | "b";
export type Runtime = "claude-code" | "codex";
export type Command =
  | { op: "create"; runtime: Runtime }
  | { op: "identity"; role: Role }
  | { op: "attach"; role: Role; nodeId: string; name: string }
  | { op: "frame"; role: Role; frame: string }
  | { op: "exchange"; role: Role }
  | { op: "state"; role: Role; kind: "authenticated" | "directory" | "message" | "sent" | "receipt"; messageId?: string }
  | { op: "cli"; action: "send"; target: string }
  | { op: "cli"; action: "receive" }
  | { op: "cli"; action: "ack"; token: string; owner: string }
  | { op: "hook"; event: "UserPromptSubmit" | "Stop"; continued: boolean }
  | { op: "close" };
export type ChildCommand = Exclude<Command, { op: "create" | "close" }> | { op: "shutdown" };
export interface Request { version: 1; id: number; caseId: string | null; command: Command }
export interface Failure { name: string; message: string; stack?: string; cause?: unknown }
export interface Reply { version: 1; id: number; result?: unknown; error?: Failure }
export interface CliResult { code: number; out: string[]; err: string[] }
export const SESSION_B = "00000000-0000-4000-8000-0000000000bb";
export const MAX_BYTES = 1024 * 1024;
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
export const uuid = (v: unknown): v is string => text(v, 36) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function validCommand(v: unknown): v is Command {
  if (!isObject(v)) return false;
  const role = v.role === "a" || v.role === "b";
  switch (v.op) {
    case "create": return keys(v, ["op", "runtime"]) && (v.runtime === "codex" || v.runtime === "claude-code");
    case "close": return keys(v, ["op"]);
    case "identity": case "exchange": return role && keys(v, ["op", "role"]);
    case "attach": return role && keys(v, ["op", "role", "nodeId", "name"]) && uuid(v.nodeId) && text(v.name) && /^[\w.-]+$/.test(v.name);
    case "frame": return role && keys(v, ["op", "role", "frame"]) && text(v.frame, MAX_BYTES);
    case "state": return role && keys(v, ["op", "role", "kind", "messageId"])
      && (v.kind === "authenticated" || v.kind === "directory" ? v.messageId === undefined
        : ["message", "sent", "receipt"].includes(String(v.kind)) && uuid(v.messageId));
    case "hook": return keys(v, ["op", "event", "continued"]) && ["UserPromptSubmit", "Stop"].includes(String(v.event)) && typeof v.continued === "boolean";
    case "cli": return v.action === "send" ? keys(v, ["op", "action", "target"]) && text(v.target) && /^[\w.-]+$/.test(v.target)
      : v.action === "receive" ? keys(v, ["op", "action"]) : v.action === "ack" && keys(v, ["op", "action", "token", "owner"]) && uuid(v.token) && v.owner === SESSION_B;
    default: return false;
  }
}
export function validRequest(v: unknown): v is Request {
  return isObject(v) && keys(v, ["version", "id", "caseId", "command"]) && v.version === 1
    && Number.isSafeInteger(v.id) && Number(v.id) > 0 && (v.caseId === null || uuid(v.caseId)) && validCommand(v.command);
}
export function failure(e: unknown): Failure {
  return e instanceof Error ? { name: e.name, message: e.message, stack: e.stack, ...(e.cause !== undefined ? { cause: e.cause } : {}) } : { name: "Error", message: String(e) };
}
declare module "vitest" {
  interface ProvidedContext { nodeHarnessPort: number; nodeHarnessToken: string }
}
