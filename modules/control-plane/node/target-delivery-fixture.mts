import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";
import { nodePaths, writeConfig } from "./config.mts";
import { storeMessage, type InboxRecord } from "./inbox.mts";
import { createTargetGroup } from "./target-delivery-state.mts";
export const TARGET_T = 1767225600000;
export const TARGET_OWNER = "00000000-0000-4000-8000-000000000706";
export const TARGET_NODE = "00000000-0000-4000-8000-000000000707";
export const TARGET_QUEUE = "00000000-0000-4000-8000-000000000708";
export const targetId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const TARGET_LIMITS = { perHour: 1, perDay: 1, spacingMs: 0 };
export function targetFixture(t: test.TestContext, count = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "target-delivery-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: TARGET_NODE, name: "synthetic",
    publicKey: "", privateKeyFile: "", policyFile: paths.policy, enrolledAt: new Date(TARGET_T).toISOString() });
  const rows: InboxRecord[] = Array.from({ length: count }, (_, n) => storeMessage(paths.inbox, {
    messageId: targetId(n + 1), from: { nodeId: TARGET_NODE, session: "synthetic-raw-sender" }, toSession: TARGET_OWNER,
    text: `synthetic private body ${n}`, createdAt: new Date(TARGET_T).toISOString(),
    senderOrigin: { nodeId: TARGET_NODE, sentAt: new Date(TARGET_T).toISOString() } }, TARGET_T));
  const producer = { codexExecutable: path.join(root, "fake-never-executed"), launchFile: path.join(root, "fake-never-executed"),
    launchPrefix: [], approvedFiles: [{ path: "/synthetic/file", realpath: "/synthetic/file", sha256: "a".repeat(64) }], resolvedCodexHome: path.join(root, "empty-home"), route: "local" as const };
  const group = createTargetGroup({ runtime: "codex", originalId: TARGET_OWNER, nodeId: TARGET_NODE,
    policyFingerprint: "b".repeat(64), lifecycleGeneration: 7, producer }, rows, TARGET_T);
  return { root, paths, rows, group, reservation: path.join(paths.dir, "codex-native-pending", `${TARGET_OWNER}.json`),
    budget: path.join(paths.dir, "listeners", `${TARGET_OWNER}.turns.json`),
    attempt: (n: number) => path.join(paths.dir, "codex-native-attempts", TARGET_OWNER, `${targetId(n)}.json`),
    groupFile: path.join(paths.dir, "target-delivery-groups", TARGET_OWNER, `${group.groupId}.json`) };
}
