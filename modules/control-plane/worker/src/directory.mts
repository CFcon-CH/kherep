import { MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";
import { MESSAGING_LOOP_BRAKE_CAPABILITY } from "../../protocol-loop-brake.mts";
import { MAX_FRAME_BYTES } from "../../protocol.mts";
import type { DirectoryNodeIntake } from "../../protocol-intake.mts";
import {
  MAX_DIRECTORY_NODES, MAX_DIRECTORY_SESSIONS, MESSAGING_PROXY_CAPABILITY, type DirectoryBody, type DirectoryNode, type DirectorySession,
} from "../../protocol-messages.mts";

// Leaves room for the envelope around the body.
const MAX_BODY_BYTES = MAX_FRAME_BYTES - 1024;

// Builds the directory body from Registry rows. Sessions of revoked nodes are
// left out even though revocation already deletes them. worker names what this
// Worker supports (issue #408: proxy answers). A node gets intake (issue #441)
// only when the map holds its measurement: a node without one reads UNKNOWN.
// A body that would not fit into one frame is cut by a fixed ladder, each step
// only while still too large, and says so in truncated: sessions from the end,
// then intake from the end of the node list, then nodes from the end.
export function directoryBody(nodeRows: Record<string, SqlStorageValue>[],
  sessions: (DirectorySession & { startedAt?: string; updatedAt?: number })[], now: number,
  intake?: Map<string, DirectoryNodeIntake>, maxBodyBytes = MAX_BODY_BYTES): DirectoryBody {
  const nodes: DirectoryNode[] = nodeRows.slice(0, MAX_DIRECTORY_NODES).map((r) => {
    const measured = intake?.get(String(r.id));
    return { nodeId: String(r.id), name: String(r.name), status: String(r.status), ...(measured ? { intake: measured } : {}) };
  });
  const listed = new Set(nodes.map((n) => n.nodeId));
  const kept = sessions.filter((s) => listed.has(s.nodeId)).map(({ startedAt: _s, updatedAt: _u, ...session }) => session);
  const body: DirectoryBody = { nodes, sessions: kept.slice(0, MAX_DIRECTORY_SESSIONS), fetchedAt: new Date(now).toISOString(),
    worker: { capabilities: [MESSAGING_PROXY_CAPABILITY, MESSAGING_LOOP_BRAKE_CAPABILITY, MESSAGING_DIAGNOSTICS_CAPABILITY] } };
  if (body.sessions.length < kept.length || nodes.length < nodeRows.length) body.truncated = true;
  const encoder = new TextEncoder();
  const fits = () => encoder.encode(JSON.stringify(body)).length <= maxBodyBytes;
  while (body.sessions.length > 0 && !fits()) {
    body.sessions.length = Math.floor(body.sessions.length * 0.9);
    body.truncated = true;
  }
  if (!fits()) {
    // The longest prefix of nodes that keeps its intake, found by bisection; the
    // result equals dropping intake one node at a time from the end.
    body.truncated = true;
    const measured = nodes.map((n) => n.intake);
    const keep = (count: number) => nodes.forEach((n, i) => {
      if (i < count && measured[i]) n.intake = measured[i];
      else delete n.intake;
    });
    let low = 0;
    let high = nodes.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      keep(mid);
      if (fits()) low = mid;
      else high = mid - 1;
    }
    keep(low);
  }
  while (nodes.length > 0 && !fits()) {
    nodes.pop();
    const remaining = new Set(nodes.map((n) => n.nodeId));
    body.sessions = body.sessions.filter((s) => remaining.has(s.nodeId));
  }
  return body;
}
