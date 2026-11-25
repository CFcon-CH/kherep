import type { PluginEntry } from "./plugin-contract.mts";

// A plugin scope this installer does not manage is reported once per scope,
// although the list is re-read after every mutator (issue #338). Scope and
// ids passed the contract's safe-string checks; no path is printed.
const reportedScopes = new Set<string>();

export function warnUnmanagedScopes(entries: PluginEntry[]): void {
  const idsByScope = new Map<string, string[]>();
  for (const entry of entries) {
    idsByScope.set(entry.scope, [...(idsByScope.get(entry.scope) ?? []), entry.id]);
  }
  for (const [scope, ids] of idsByScope) {
    if (reportedScopes.has(scope)) continue;
    reportedScopes.add(scope);
    process.stdout.write(`reconcile-plugins: skipping plugin scope ${scope}: ${ids.join(", ")} (not managed here)\n`);
  }
}
