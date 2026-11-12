import fs from "node:fs";
import path from "node:path";

import { codexHome } from "./codex-app.mts";
import type { NodePaths } from "./config.mts";
import { pidAlive } from "./daemon-state.mts";
import { checkRuntimes, checkWorker, findRuntime, runtimeVersion, type VersionOf } from "./doctor-host.mts";
import { checkQueueDrain } from "./doctor-drain.mts";
import { checkManagedService } from "./doctor-service.mts";
import type { ServiceOwnerProbe } from "./service-drain.mts";
import { checkHooks } from "./doctor-hooks.mts";
import { checkIntakeLatency } from "./doctor-intake.mts";
import { checkIntercom } from "./doctor-intercom.mts";
import { checkWakeBudget } from "./doctor-wake-budget.mts";
import {
  checkCodexForkAttempts, checkCodexSessions, checkDaemon, checkEnrollment, checkListeners, checkPolicy, checkWakeReadiness, daemonReadiness, type Check,
} from "./doctor-local.mts";
import { defaultConfigDir } from "./launch-mode.mts";

// `kherep-node doctor` (issue #215): whether this host can take part, as JSON.
// Any failed check makes ok false and the command exit 1. The report holds
// ids, versions, counts, times and paths, never key material, tokens or
// message bodies.

// This checkout: node/ -> control-plane/ -> modules/ -> repository root.
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export interface DoctorDeps {
  paths: NodePaths;
  repoRoot?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  fetch?: typeof fetch;
  find?: (name: string) => string | null;
  versionOf?: VersionOf;
  pidAlive?: (pid: unknown) => boolean;
  now?: () => number;
  serviceOwnerProbe?: ServiceOwnerProbe;
}

export interface DoctorReport { ok: boolean; version: string | null; checks: Record<string, Check> }

function checkoutVersion(repoRoot: string): string | null {
  try {
    const version = (JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

const notEnrolled: Check = { ok: false, detail: "needs an enrolled node" };

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const alive = deps.pidAlive ?? pidAlive;
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const { check: enrollment, config } = checkEnrollment(deps.paths);
  const { check: policy, policy: parsed } = checkPolicy(config?.policyFile ?? deps.paths.policy);
  const claudeConfigDir = deps.claudeConfigDir ?? defaultConfigDir();
  const codex = deps.codexHome ?? codexHome();
  const clock = deps.now ?? Date.now;
  const worker = config ? await checkWorker(config.controlUrl, deps.fetch ?? fetch) : notEnrolled;
  const runtimes = await checkRuntimes(parsed?.sessions?.enabled ? parsed.sessions.runtimes : [],
    deps.find ?? findRuntime, deps.versionOf ?? runtimeVersion, daemonReadiness(deps.paths, alive), clock());
  // The other checks are judged against one clock taken after the awaited probes.
  // Wake readiness and budget sample theirs after reading the snapshot and each
  // ledger instead, so a listing or turn written while doctor runs is not
  // future-dated.
  const now = clock();
  const checks: Record<string, Check> = {
    enrollment,
    daemon: checkDaemon(deps.paths, alive, repoRoot),
    worker,
    policy,
    runtimes,
    hooks: checkHooks({
      claude: path.join(claudeConfigDir, "settings.json"),
      codex: path.join(codex, "config.toml"),
    }, repoRoot),
    // Issue #436: the stable intercom command and the files that name it.
    intercom: checkIntercom({ paths: deps.paths, claudeConfigDir, codexHome: codex }),
    listeners: checkListeners(deps.paths, alive, now),
    wakeReadiness: checkWakeReadiness(deps.paths, parsed, alive, clock),
    wakeBudget: checkWakeBudget(deps.paths, parsed, clock),
    codexSessions: checkCodexSessions(deps.paths, now),
    // Issue #441: control-plane accept to local store, last two hours; only messages that arrived.
    intakeLatency: checkIntakeLatency(deps.paths, now),
    codexForkAttempts: checkCodexForkAttempts(deps.paths),
    // Issue #441: the control plane's queue for this node, as of the last directory.
    queueDrain: checkQueueDrain(deps.paths, now),
    // Issue #838: the managed service node state, as `service status` reports it.
    managedService: checkManagedService(deps.paths, alive, deps.serviceOwnerProbe),
  };
  return { ok: Object.values(checks).every((check) => check.ok), version: checkoutVersion(repoRoot), checks };
}
