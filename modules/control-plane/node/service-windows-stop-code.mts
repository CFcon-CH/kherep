import { nativeFailure, stopScriptReport } from "./service-windows-invoke.mts";
import type { StopCode } from "./service-types.mts";

// #838 A3: a failed Windows stop is classified by where it failed, not by one catch-all. Only positive pre-effect
// evidence (a failure before the stop script was spawned, or the completed script's own pre-effect report) marks
// the stop as not issued with the family proven untouched; every other failure keeps familyUnproven as before
// (#472/#677). A timeout or a killed script never carries a report, so it is never pre-effect.
export interface WindowsStopClassification { code: StopCode; familyUnproven: boolean; notIssued: boolean }

const DESCENDANT_REASONS = new Set(["descendants-busy"]);
const IDENTITY_REASONS = new Set(["supervisor-provenance", "supervisor-owner", "supervisor-identity", "supervisor-child",
  "daemon-provenance", "daemon-identity", "definition-changed", "instance-changed"]);
// The process table or the family could not be read: kept unproven in any phase.
const UNKNOWN_FAMILY_REASONS = new Set(["provenance-unknown", "family-unproven"]);

function preEffectCode(reason: string): StopCode {
  if (DESCENDANT_REASONS.has(reason)) return "STOP_BLOCKED_NATIVE_DESCENDANTS";
  if (IDENTITY_REASONS.has(reason)) return "STOP_IDENTITY_MISMATCH";
  return "STOP_NATIVE_REFUSED";
}

export function classifyWindowsStop(error: unknown, spawned: boolean): WindowsStopClassification {
  if (!spawned) return { code: "STOP_NATIVE_REFUSED", familyUnproven: false, notIssued: true };
  if (nativeFailure(error)?.outcome === "timeout") return { code: "STOP_UNPROVEN_TIMEOUT", familyUnproven: true, notIssued: false };
  const report = stopScriptReport(error);
  if (report && UNKNOWN_FAMILY_REASONS.has(report.reason)) return { code: "STOP_UNKNOWN_DESCENDANTS", familyUnproven: true, notIssued: false };
  if (report?.phase === "pre-effect") return { code: preEffectCode(report.reason), familyUnproven: false, notIssued: true };
  return { code: "STOP_NATIVE_REFUSED", familyUnproven: true, notIssued: false };
}
