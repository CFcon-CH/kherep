// Issue #808, stage 2b: the guard canary's verdict, from observations only (no I/O). Lead decision D2 A:
// the deny evidence is a substring of commit-guard's fixed deny text in the raw output, no schema parsing.
// Golden rule: absent evidence never passes. ALLOWED needs the bad commit in git log; DENIED needs the
// control commit, no bad commit and the deny text; anything else is INCONCLUSIVE.

// claude/hooks/commit-guard.mts prints this for an em dash; guard-canary-verdict.test.mts pins it to the source.
export const DENY_TEXT = "commit message contains an em dash (U+2014)";
export const EM_DASH = String.fromCharCode(0x2014);
export const CONTROL_PREFIX = "kherep-canary-control";
export const BAD_PREFIX = "kherep-canary-bad";

export type Verdict = "ALLOWED" | "DENIED" | "INCONCLUSIVE";
export interface Decision { verdict: Verdict; exitCode: 0 | 1 | 2; reason: string }
// subjects: git log subjects of the throwaway repo, null when git log could not be read.
// failure: why the runtime never ran (cli-missing, spawn-failed:<code>, repo-setup-failed).
export interface LiveObservation { nonce: string; failure?: string; timedOut: boolean; subjects: string[] | null; output: string }
export interface SyntheticObservation { failure?: string; timedOut: boolean; exitCode: number | null; stdout: string; stderr: string }

const allowed = (reason: string): Decision => ({ verdict: "ALLOWED", exitCode: 1, reason });
const denied = (): Decision => ({ verdict: "DENIED", exitCode: 0, reason: "deny-evidence" });
const inconclusive = (reason: string): Decision => ({ verdict: "INCONCLUSIVE", exitCode: 2, reason });

export function liveVerdict(o: LiveObservation): Decision {
  if (!o.subjects) return inconclusive("git-log-unreadable");
  const badMarker = `${BAD_PREFIX} ${o.nonce}`;
  if (o.subjects.some((s) => s.startsWith(badMarker) && s.includes(EM_DASH))) return allowed("bad-commit-exists");
  if (o.failure) return inconclusive(o.failure);
  if (o.timedOut) return inconclusive("timeout");
  if (!o.subjects.includes(`${CONTROL_PREFIX} ${o.nonce}`)) return inconclusive("no-control-commit");
  if (o.subjects.some((s) => s.startsWith(badMarker))) return inconclusive("bad-commit-altered");
  return o.output.includes(DENY_TEXT) ? denied() : inconclusive("no-deny-evidence");
}

// The dispatcher's PreToolUse decision on stdout, "" when none, undefined when stdout is not readable.
function printedDecision(stdout: string): { decision: string; reason: string } | undefined {
  if (!stdout.trim()) return { decision: "", reason: "" };
  try {
    const out = (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown } }).hookSpecificOutput;
    return { decision: String(out?.permissionDecision ?? ""), reason: String(out?.permissionDecisionReason ?? "") };
  } catch { return undefined; }
}

// A deny counts only with the deny text in its reason (printed) or on stderr with exit 2 (the hook protocol).
export function syntheticVerdict(o: SyntheticObservation): Decision {
  if (o.failure) return inconclusive(o.failure);
  if (o.timedOut) return inconclusive("timeout");
  if (o.exitCode === 2) return o.stderr.includes(DENY_TEXT) ? denied() : inconclusive("deny-without-evidence");
  if (o.exitCode !== 0) return inconclusive("deny-without-evidence");
  const printed = printedDecision(o.stdout);
  if (!printed) return inconclusive("dispatcher-output-unreadable");
  if (printed.decision === "deny" && printed.reason.includes(DENY_TEXT)) return denied();
  return printed.decision === "deny" || printed.decision === "ask" ? inconclusive("deny-without-evidence") : allowed("dispatcher-allowed");
}

// Any ALLOWED is 1; otherwise any INCONCLUSIVE, or no result at all, is 2; only all DENIED is 0.
export function overallExit(decisions: { exitCode: number }[]): 0 | 1 | 2 {
  if (decisions.some((d) => d.exitCode === 1)) return 1;
  return decisions.length && decisions.every((d) => d.exitCode === 0) ? 0 : 2;
}
