import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { nodePaths } from "./config.mts";
export const ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const owner = { sessionId: OWNER, runtime: "codex" as const, lifecycleGeneration: null };
  const body = { messageId: ID, from: { nodeId: PEER, session: "source" }, toSession: OWNER,
    text: "Synthetic storage body", createdAt: new Date(0).toISOString(),
    binding: { version: 1 as const, mode: "exact" as const, from: { ...owner, sessionId: "source" }, to: owner,
      leaseId: ID, localGeneration: null } };
  return { root, paths, body, bound: path.join(paths.inbox, "bound-v1", `${ID}.json`), flat: path.join(paths.inbox, `${ID}.json`) };
}
