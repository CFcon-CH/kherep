import { messageOwnerMatches } from "./message-owner.mts";
import type { SelectedOwner } from "../protocol-message-binding.mts";
import fs from "node:fs";
import path from "node:path";

import {
  isMcpCredentialBody, isMcpIntentReceiptBody, isMcpIntentRegistration,
  type McpCredentialBody, type McpInboxItem, type McpIntentReceiptBody, type McpIntentRegistration,
} from "../protocol-mcp.mts";
import type { NodeClient } from "./client.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { getMessage, listInbox, markAnswered, markOffered, writeJsonAtomic } from "./inbox.mts";
import { writePrivateWindowsMcpCredential, type CredentialPowerShellDeps } from "./mcp-credential-file.mts";
import { publishSessionFrames } from "./session-publication.mts";

const fileOf = (dir: string, requestId: string): string => path.join(dir, `${requestId}.json`);
const MAX_LOCAL_INTENTS = 128;
const LOCAL_RECORD_RETENTION_MS = 10 * 60_000;
// The trusted hook still waits eight seconds. Unregistered requests cannot
// occupy the discovery lane after their originating hook has stopped waiting.
const NATIVE_INTENT_WINDOW_MS = 8_000;

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function removeJsonFiles(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) fs.rmSync(path.join(dir, name), { force: true });
}

function removeCredentialFiles(paths: NodePaths): void {
  fs.rmSync(paths.mcpCredential, { force: true });
  let names: string[];
  try { names = fs.readdirSync(paths.mcp); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const prefix = `.${path.basename(paths.mcpCredential)}.`;
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) fs.rmSync(path.join(paths.mcp, name), { force: true });
  }
}

export function hasMcpCredential(paths: NodePaths): boolean {
  try {
    const body = readJson(paths.mcpCredential);
    return isMcpCredentialBody(body) && body.ok;
  } catch {
    return false;
  }
}

export function recordMcpCredential(paths: NodePaths, body: McpCredentialBody,
  credential?: CredentialPowerShellDeps): void {
  if (!body.ok) return;
  ensureDir(paths.mcp);
  if (process.platform === "win32") writePrivateWindowsMcpCredential(paths.mcpCredential, body, credential);
  else writeJsonAtomic(paths.mcpCredential, body);
}

export function disableMcp(paths: NodePaths, inflight: Set<string>): void {
  let failure: unknown;
  for (const clear of [
    () => removeCredentialFiles(paths),
    () => removeJsonFiles(paths.mcpIntents),
    () => removeJsonFiles(paths.mcpReceipts),
  ]) {
    try { clear(); } catch (error) { failure ??= error; }
  }
  inflight.clear();
  if (failure) throw failure;
}

export function enqueueMcpIntent(paths: NodePaths, body: McpIntentRegistration): void {
  if (!isMcpIntentRegistration(body)) throw new Error("invalid MCP intent metadata");
  ensureDir(paths.mcpIntents);
  const files = fs.readdirSync(paths.mcpIntents).filter((name) => name.endsWith(".json"));
  for (const name of files) {
    const file = path.join(paths.mcpIntents, name);
    if (Date.now() - fs.statSync(file).mtimeMs > LOCAL_RECORD_RETENTION_MS) fs.unlinkSync(file);
  }
  if (fs.readdirSync(paths.mcpIntents).filter((name) => name.endsWith(".json")).length >= MAX_LOCAL_INTENTS) {
    throw new Error("too many pending MCP intents");
  }
  writeJsonAtomic(fileOf(paths.mcpIntents, body.requestId), body);
}

export async function pollMcpIntents(client: NodeClient, paths: NodePaths, inflight: Set<string>, send: (frame: string) => boolean,
  beforeSnapshot?: () => Promise<boolean>): Promise<void> {
  if (!client.authenticated) return;
  ensureDir(paths.mcpIntents);
  const pending: McpIntentRegistration[] = [];
  const deadlines = new Map<string, number>();
  for (const name of fs.readdirSync(paths.mcpIntents).filter((entry) => entry.endsWith(".json")).slice(0, 128)) {
    const file = path.join(paths.mcpIntents, name);
    let body: unknown;
    try { body = readJson(file); } catch { continue; }
    if (!isMcpIntentRegistration(body) || inflight.has(body.requestId)) continue;
    const deadline = fs.statSync(file).mtimeMs + NATIVE_INTENT_WINDOW_MS;
    if (deadline <= Date.now()) { fs.rmSync(file, { force: true }); continue; }
    pending.push(body);
    deadlines.set(body.requestId, deadline);
  }
  if (pending.length === 0) return;
  const expired = (body: McpIntentRegistration): boolean => {
    if (deadlines.get(body.requestId)! > Date.now()) return false;
    fs.rmSync(fileOf(paths.mcpIntents, body.requestId), { force: true });
    return true;
  };
  const register = async (body: McpIntentRegistration): Promise<boolean> => {
    if (expired(body)) return true;
    const [frame] = body.tool === "assign_self" ? await client.registerMcpAssignment(body, beforeSnapshot) : client.registerMcpIntent(body);
    if (expired(body)) return true;
    if (!frame && body.tool === "assign_self") {
      recordMcpIntentReceipt(paths, inflight, { requestId: body.requestId, ok: false, error: "verified original Codex Mac identity and native title are required" });
      return true;
    }
    if (!frame || !send(frame)) return false;
    inflight.add(body.requestId);
    return true;
  };
  const known = new Set(client.knownMcpIntents(pending));
  for (const body of known) if (!await register(body)) return;
  let unresolved = pending.filter(body => !known.has(body));
  if (unresolved.length === 0) return;
  const remainingMs = Math.min(...unresolved.map(body => deadlines.get(body.requestId)!)) - Date.now();
  const snapshots = await client.sessionsBeforeMcpIntents(beforeSnapshot, remainingMs);
  if (snapshots === null) return;
  unresolved = unresolved.filter(body => !expired(body));
  if (unresolved.length === 0) { client.invalidateSessionsSnapshot(); return; }
  if (!publishSessionFrames(client, snapshots, send)) return;
  for (const body of unresolved) if (!await register(body)) return;
}

export function recordMcpIntentReceipt(paths: NodePaths, inflight: Set<string>, body: McpIntentReceiptBody): void {
  if (!isMcpIntentReceiptBody(body)) return;
  ensureDir(paths.mcpReceipts);
  for (const name of fs.readdirSync(paths.mcpReceipts).filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(paths.mcpReceipts, name);
    if (Date.now() - fs.statSync(file).mtimeMs > LOCAL_RECORD_RETENTION_MS) fs.unlinkSync(file);
  }
  writeJsonAtomic(fileOf(paths.mcpReceipts, body.requestId), body);
  inflight.delete(body.requestId);
  try { fs.unlinkSync(fileOf(paths.mcpIntents, body.requestId)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function readMcpIntentReceipt(paths: NodePaths, requestId: string): McpIntentReceiptBody | null {
  try {
    const body = readJson(fileOf(paths.mcpReceipts, requestId));
    return isMcpIntentReceiptBody(body) ? body : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function consumeMcpIntentReceipt(paths: NodePaths, requestId: string): McpIntentReceiptBody | null {
  const body = readMcpIntentReceipt(paths, requestId);
  if (body) fs.unlinkSync(fileOf(paths.mcpReceipts, requestId));
  return body;
}

// messageId (issue #308): only that record, and only when it is addressed to sessionId.
export function readMcpInbox(paths: NodePaths, sessionId: string, limit: number, messageId?: string, runtime = "codex"): McpInboxItem[] {
  return listInbox(paths.inbox, sessionId).filter(r => messageOwnerMatches(r, { sessionId, runtime }, [sessionId])).filter((record) => messageId === undefined || record.messageId === messageId)
    .slice(-limit).map((record) => ({
    messageId: record.messageId, from: { ...record.from }, createdAt: record.createdAt, text: record.text,
    ...(record.inReplyTo ? { inReplyTo: record.inReplyTo } : {}), depth: record.depth ?? 0,
  }));
}

// Issue #308: the waiting records an inbox response returned to the session
// are offered, as a delivery hook offers them. The session's Stop (when its
// client fires hooks) or a reply confirms them; a client without hooks
// reaches delivered only through a reply. Already offered or final records
// stay as they are.
export function offerMcpInbox(paths: NodePaths, messageIds: string[], now: number = Date.now(), owner?: SelectedOwner): void {
  for (const id of messageIds) {
    const record = getMessage(paths.inbox, id);
    if (record?.state === "accepted" && messageOwnerMatches(record, owner, [record.toSession])) markOffered(paths.inbox, id, now, "mcp");
  }
}

// An MCP reply the Worker routes through this node (issue #308) answers the
// record, as `msg send --reply-to` does.
export function answerMcpInbox(paths: NodePaths, messageIds: string[], owner?: SelectedOwner): void {
  for (const id of messageIds) {
    const record = getMessage(paths.inbox, id);
    if (record && messageOwnerMatches(record, owner, [record.toSession])) markAnswered(paths.inbox, id);
  }
}
