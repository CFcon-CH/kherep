import fs from "node:fs";
import path from "node:path";

import { isSessionRef } from "../protocol-messages.mts";
import { fullSessionId } from "../protocol-session-identity.mts";
import { isNodeId } from "../protocol.mts";
import { bypassesPermissions } from "./autonomy.mts";
import { ensureDir, readConfig, type NodePaths } from "./config.mts";
import { MAX_CONTEXT_BYTES } from "./deliver-core.mts";
import { readDirectory, readLocalSessions } from "./exchange.mts";
import { writeJsonAtomic } from "./inbox.mts";

const MAX_NAMES = 1536, MAX_CACHE_BYTES = 1024 * 1024;
const safeName = (value: unknown): value is string => isSessionRef(value) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// Claude and Codex entrypoints supply the runtime. No native discovery or authority is added.
export function renameOwner(input: Record<string, unknown>): string | undefined {
  return fullSessionId(input.session_id) && !Object.hasOwn(input, "agent_id") && !bypassesPermissions(input.permission_mode)
    ? input.session_id.toLowerCase() : undefined;
}

function previousNames(file: string, nodeId: string): Record<string, string> {
  try {
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(MAX_CACHE_BYTES + 1);
    let size: number;
    try { size = fs.readSync(fd, buffer, 0, buffer.length, 0); }
    finally { fs.closeSync(fd); }
    if (size > MAX_CACHE_BYTES) return {};
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    if (!object(value) || Object.keys(value).length !== 2 || value.nodeId !== nodeId || !object(value.names)) return {};
    const entries = Object.entries(value.names);
    if (entries.length > MAX_NAMES || !entries.every(([key, name]) => {
      const parts = key.split("/");
      return parts.length === 2 && isNodeId(parts[0]) && fullSessionId(parts[1]) && safeName(name);
    })) return {};
    return value.names as Record<string, string>;
  } catch { return {}; } // Disposable display state only; authority stores are untouched.
}

interface Subject { name: string; codex: boolean }
function currentNames(paths: NodePaths, nodeId: string, owner: string): Map<string, Subject> {
  const names = new Map<string, Subject | null>();
  const add = (node: string, row: { sessionId?: unknown; runtime?: unknown; name?: unknown; title?: unknown }) => {
    // A Codex session is shown by its thread title, a Claude session by its name (issue #828).
    const codex = row.runtime === "codex", name = codex ? row.title : row.name;
    if (!codex && row.runtime !== "claude-code" || !fullSessionId(row.sessionId) || !safeName(name)) return;
    const session = row.sessionId.toLowerCase(), key = `${node}/${session}`;
    if (node === nodeId && session === owner) return;
    const prior = names.get(key);
    names.set(key, names.has(key) && (prior?.name !== name || prior.codex !== codex) ? null : { name, codex });
  };
  try { for (const row of readLocalSessions(paths).slice(0, 512)) add(nodeId, row); } catch { /* no valid local projection */ }
  try {
    for (const row of readDirectory(paths)?.sessions ?? []) if (row.nodeId !== nodeId) add(row.nodeId, row);
  } catch { /* no valid stored Directory */ }
  return new Map([...names].filter((entry): entry is [string, Subject] => entry[1] !== null).sort(([a], [b]) => a.localeCompare(b)));
}

// Caller holds the existing per-owner hook lock. Remember before returning output:
// five-line/byte omissions and failed stdout are intentionally never replayed.
export function appendRenameHint(paths: NodePaths, owner: string, context: string, maxBytes = MAX_CONTEXT_BYTES): string {
  try {
    const nodeId = readConfig(paths.config)?.nodeId;
    if (!nodeId) return context;
    const file = path.join(paths.dir, "rename-notices", `${owner}.json`);
    const previous = previousNames(file, nodeId), current = currentNames(paths, nodeId, owner);
    const names = Object.fromEntries([...current].map(([key, subject]) => [key, subject.name]));
    const changed = [...current].filter(([key, { name }]) => Object.hasOwn(previous, key) && previous[key] !== name);
    let output = context, shown = 0;
    const append = (line: string): boolean => {
      const candidate = output ? `${output}\n\n${line}` : line;
      if (Buffer.byteLength(candidate, "utf8") > Math.min(maxBytes, MAX_CONTEXT_BYTES)) return false;
      output = candidate;
      return true;
    };
    for (const [key, { name, codex }] of changed) {
      if (shown === 5) break;
      const [node, session] = key.split("/"), old = JSON.stringify(previous[key]), now = JSON.stringify(name);
      // The runtime is named so that a title is never read as an address.
      const subject = codex ? `Codex id ${session}, previous title ${old}, observed title ${now}. Display hint only; a title is not an address, use msg sessions for current lookup.`
        : `id ${session}, previous name ${old}, observed name ${now}. Display hint only; use msg sessions for current lookup.`;
      if (append(`Kherep session-label data: node ${node}, ${subject} No reply required.`)) shown++;
    }
    if (changed.length > shown) append(`and ${changed.length - shown} more, see msg sessions`);
    ensureDir(path.dirname(file));
    writeJsonAtomic(file, { nodeId, names });
    return output;
  } catch { return context; } // Cache failure cannot suppress ordinary peer context.
}
