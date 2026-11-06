/**
 * hook-integrity-sources.mts  -  what the Codex hook-integrity hook (hook-integrity.mts)
 * checks beyond the import closure of every .mts/.js file a config.toml hook command
 * names under <CODEX_HOME>/hooks, and where each installed file comes from. Issue
 * #533: loaded by hook-integrity.mts as an own step, so a broken copy of this file is
 * reported (kind "self") and restored.
 */

// privacy-boundary-guard.mts requires workspace-scope and private-path-policy by a
// computed path the walk cannot see (the other two are the latter's imports), and
// dispatch-contract-guard.mts requires obs-brief-policy (issue #331) and
// worker-brief-policy (issue #701) the same way,
// so the walk reads them as imports of the guard that loads them.
export const COMPUTED: Record<string, string[]> = {
  // Registers the child guard edges appended by computedImports below; its re-check lib
  // is loaded by a computed path like the adapter's (issue #507, part 4).
  "kherep-maestro/codex-shell-checks.mts": ["guard-recheck"],
  "kherep-maestro/codex-privacy-boundary-guard.mts": ["workspace-scope", "private-path-policy", "private-path-rules", "real-path-policy"],
  "kherep-maestro/codex-dispatch-contract-guard.mts": ["obs-brief-policy", "worker-brief-policy"],
  // The adapter loads its re-check lib (issue #507, part 3) and the denied-call journal lib (issue #504) by a computed path.
  "kherep-maestro/codex-hook-adapter.mts": ["guard-recheck", "denial-journal"],
  "kherep-maestro/hook-adapter.mts": ["guard-recheck", "denial-journal"],
};
export const ALWAYS_CHECK = Object.values(COMPUTED).flat().map((name) => `./lib/${name}.mts`);
export const computedImports = (rel: string): string => (COMPUTED[rel] || []).map((name) => `\nimport "./lib/${name}.mts";`).join("")
  + (rel === "kherep-maestro/codex-shell-checks.mts"
    ? ["commit-guard", "deploy-guard", "main-checkout-guard", "module-label-guard"].map(name => `\nimport "./${name}.mts";`).join("") : "");
// Issue #507, part 4. Files no hook checks for itself; each dispatcher compares the other's stat
// with the record a proven run leaves in heartbeat.json "peers" (lib/integrity-heartbeat.mts provenPeer).
export const DISPATCHERS = new Set(["kherep-maestro/codex-hook-adapter.mts", "kherep-maestro/hook-adapter.mts", "kherep-maestro/codex-shell-checks.mts"]);
export const RENDERED = new Set(["kherep-maestro/codex-observation-stop.mts", "kherep-maestro/codex-observation-turn-completion.mts"]);
// Copied from codex/hooks under their own name; every other plain name is a shared Claude guard.
export const CODEX_HELPERS = new Set(["acceptance-policy.mts", "obs-candidate-policy.mts", "obs-result-policy.mts", "research-common.mts", "research-exec-parser.mts",
  "research-transcript.mts", "post-edit-tool-calls.mts", "hook-adapter.mts", "hook-adapter-payload.mts", "hook-adapter-verdict.mts",
  "hook-adapter-run.mts", "hook-integrity-repair.mts", "hook-integrity-sources.mts"]);

// The checkout path of the versioned source of an installed file (rel to
// <CODEX_HOME>/hooks), or why there is none.
export function sourceOf(rel: string): { from: string } | { hint: string } {
  if (rel === "kherep-maestro/obs-candidate-policy.mts") return {from:"modules/atl-jira-brokers/observation-candidate.mts"};
  if (rel === "kherep-maestro/obs-result-policy.mts") return {from:"modules/atl-jira-brokers/observation-result.mts"};
  if (RENDERED.has(rel)) return { hint: "rendered by the installer, no byte-identical source; run codex/install.mts" };
  if (rel === "kherep-maestro-context.mts") return { from: "codex/hooks/kherep-maestro-context.mts" };
  const own = /^kherep-maestro\/(.+)$/.exec(rel)?.[1];
  if (own?.startsWith("lib/")) return { from: `claude/hooks/${own}` };
  if (!own || own.includes("/")) return { hint: "not installed by Kherep, so there is no versioned source" };
  if (own.startsWith("codex-")) return { from: `codex/hooks/${own.slice("codex-".length)}` };
  return { from: `${CODEX_HELPERS.has(own) ? "codex" : "claude"}/hooks/${own}` };
}
