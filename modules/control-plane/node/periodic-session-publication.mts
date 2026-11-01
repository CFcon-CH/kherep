import type { AdmissionAuthority } from "./session-authority.mts";
import type { NodeClient } from "./client.mts";
import type { SessionInfo } from "../protocol.mts";
import type { NodePaths } from "./config.mts";
import { recordingSessions } from "./exchange.mts";
import type { InboxRecord } from "./inbox.mts";
import { publishSessionFrames } from "./session-publication.mts";

// records: the daemon's inbox index for the refusal check (exchange-sessions.mts, issue #589).
export async function recordAndPublishSessions(client: NodeClient, paths: NodePaths, sessions: SessionInfo[],
  send: (frame: string) => boolean, log: (line: string) => void, signal: AbortSignal, records?: () => InboxRecord[], authority?: AdmissionAuthority): Promise<void> {
  const recorded = await recordingSessions(paths, async () => sessions, log, undefined, undefined, records, authority)(signal);
  publishSessionFrames(client, client.sessionFrames(recorded), send);
}
