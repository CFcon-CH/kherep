import fs from "node:fs";
import path from "node:path";
import { captureSourceIdentity, type SourceIdentity } from "./daemon-source.mts";
import { describeServiceDrain } from "./service-drain.mts";
import { windowsArgs } from "./service-definitions.mts";
import { decodeSupervisorBinding } from "./service-supervisor-data.mts";
import { readServiceCandidate, readServiceReceipt, serviceRoot, snapshotDigests, type ServiceCandidate } from "./service-records.mts";
import { lifecycleDefaults, sourceMatches, verifyExact, type LifecycleDependencies } from "./service-lifecycle.mts";
import { recordedPriorBackup, sameBinding } from "./service-transaction-support.mts";
import { persistCandidate } from "./service-candidate-record.mts";
import type { ServiceBinding } from "./service-types.mts";

export interface LegacyRecoveryOptions { backup: string; source: string }

// No link or ancestor may redirect a claimed pin/check-out outside its canonical location.
function canonicalDirectory(root: string): string {
  const assertUnlinked = (directory: string): void => {
    for (let cursor = directory; ; cursor = path.dirname(cursor)) {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(cursor); } catch { throw new Error("recovery source directory is unavailable"); }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("recovery source has a linked or invalid ancestor");
      if (path.dirname(cursor) === cursor) break;
    }
  };
  const resolved = path.resolve(root);
  assertUnlinked(resolved);
  let real: string;
  try { real = fs.realpathSync.native(resolved); } catch { throw new Error("recovery source directory is unavailable"); }
  assertUnlinked(real);
  let repeated: string;
  try { repeated = fs.realpathSync.native(resolved); } catch { throw new Error("recovery source directory is unavailable"); }
  if (repeated !== real) throw new Error("recovery source changed while resolving");
  return real;
}

// Caller holds the service lock. No native mutation, backup creation or record write occurs before all predicates pass.
export async function recoverLegacyCandidate(options: LegacyRecoveryOptions, input: LifecycleDependencies): Promise<void> {
  const receipt = readServiceReceipt(input.paths);
  if (!receipt || receipt.binding.platform !== "win32") throw new Error("legacy recovery requires a managed Windows receipt");
  let receiptStat: fs.Stats;
  try { receiptStat = fs.lstatSync(path.join(serviceRoot(input.paths), "receipt.json")); }
  catch { throw new Error("legacy recovery receipt is unavailable"); }
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) throw new Error("legacy recovery receipt is not a regular file");
  if (readServiceCandidate(input.paths)) throw new Error("a candidate record already exists; use ordinary rollback");
  const drain = describeServiceDrain(input.paths, input.ownerProbe);
  if (drain === "active" || drain === "unknown") throw new Error("legacy recovery drain owner cannot be reclaimed");
  const capture = input.captureSource ?? captureSourceIdentity;
  const verifiedPin = (identity: SourceIdentity): void => {
    const expected = path.join(serviceRoot(input.paths), "source-pins", identity.commit);
    if (identity.kind !== "pin" || canonicalDirectory(identity.root) !== canonicalDirectory(expected)) {
      throw new Error("recovery source pin is outside its expected root");
    }
    let measured: SourceIdentity;
    try { measured = capture(identity.root); } catch { throw new Error("recovery source pin cannot be verified"); }
    if (measured.kind !== "pin" || !sourceMatches(identity, measured)) throw new Error("recovery source pin cannot be verified");
  };
  verifiedPin(receipt.binding.source);
  const native = await input.adapter.read(receipt.binding);
  if (!native?.windows || native.running === "unknown" || native.windows.actions.length !== 1) {
    throw new Error("legacy recovery requires one attested Windows task action");
  }
  const tokens = windowsArgs(native.windows.actions[0].arguments);
  if (tokens.length !== 4 || tokens[0] !== "--headless") throw new Error("legacy recovery action is not a managed supervisor");
  const binding = decodeSupervisorBinding(tokens[3]);
  if (!sameBinding(binding, receipt.binding) || tokens[1] !== binding.nodeExecutable
    || tokens[2] !== path.join(binding.source.root, "modules", "control-plane", "node", "service-supervisor.mts")) {
    throw new Error("legacy recovery task binding differs from its receipt");
  }
  verifiedPin(binding.source);
  const checkoutRoot = canonicalDirectory(options.source);
  let checkout: SourceIdentity;
  try { checkout = capture(checkoutRoot); } catch { throw new Error("legacy recovery checkout cannot be verified"); }
  if (checkout.kind !== "checkout" || !checkout.verified || !sourceMatches(binding.source, checkout)) {
    throw new Error("legacy recovery checkout does not identify the candidate source");
  }
  await input.adapter.validateManaged(native, binding);
  if (!/^[0-9]{8,14}-[0-9a-f-]{36}$/.test(options.backup)) throw new Error("legacy recovery backup id is invalid");
  const backupRoot = canonicalDirectory(path.join(serviceRoot(input.paths), "backups", options.backup));
  for (const name of ["backup.json", "definition.bin", "security.bin"]) {
    const file = path.join(backupRoot, name);
    let stat: fs.Stats, real: string;
    try { stat = fs.lstatSync(file); real = fs.realpathSync.native(file); }
    catch { throw new Error("legacy recovery backup file is unavailable"); }
    if (!stat.isFile() || stat.isSymbolicLink() || real !== file) {
      throw new Error("legacy recovery backup contains a linked or invalid file");
    }
  }
  const candidate: ServiceCandidate = { version: 2, phase: "attested", preparedAt: lifecycleDefaults(input).now(),
    binding, ...snapshotDigests(native), backupId: options.backup, command: "upgrade" };
  const prior = recordedPriorBackup(input.paths, candidate, receipt);
  if (!prior || prior.backup.id !== options.backup || typeof prior.backup.wasRunning !== "boolean"
    || !Number.isFinite(Date.parse(prior.backup.createdAt))
    || !prior.backup.priorSource || !sourceMatches(receipt.binding.source, prior.backup.priorSource)) {
    throw new Error("legacy recovery backup does not bind to the current receipt");
  }
  verifiedPin(prior.backup.priorSource);
  const retargeted = await input.adapter.retargeted(prior.snapshot, binding);
  if (!native.definition.equals(retargeted) || !native.security.equals(prior.snapshot.security)) {
    throw new Error("legacy recovery task differs from the exact backup retarget");
  }
  const deps = lifecycleDefaults(input), state = deps.readState(input.paths);
  if (native.running === true && (!state || !deps.alive(state.pid) || !sourceMatches(binding.source, state.source)
    || state.service?.name !== binding.serviceName || state.service.platform !== binding.platform || state.service.taskPath !== binding.taskPath
    || !await input.adapter.processOwned(state.pid, binding, state.startedAt))) throw new Error("legacy recovery process ownership cannot be verified");
  if (native.running === false && state && deps.alive(state.pid)) throw new Error("a live daemon remains outside the stopped selected service");
  await input.adapter.preflightStop(binding, native.running === true && state ? { pid: state.pid, startedAt: state.startedAt } : undefined);
  await verifyExact(input.adapter, binding, native);
  persistCandidate(input.paths, candidate, input.writeCandidate);
}
