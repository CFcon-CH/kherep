// Issue #1010. Raises installed user-scope plugins to the version Kherep last
// reviewed (bootstrap/manifest/plugin-versions.json). A plugin whose version
// differs from the reviewed one gets its marketplace refreshed and one
// `plugin update`; the re-read state decides what happened. Claude takes no
// version argument, so a raise lands on whatever the marketplace pins now.
// Plugins that live outside the Claude home this run installs are never touched.

import { ReconcileError, safeString, userPluginEntry, type ClaudeState } from "./plugin-contract.mts";
import { isRecord } from "./shape.mts";
import { insideRoot } from "./test-route-compare.mts";

const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export interface RaiseRequest {
  versionManifestPath: string;
  claudeHome: string;
}

interface RaiseTarget {
  id: string;
  marketplace: string;
  installed: unknown;
  reviewed: string;
}

export interface RaiseActions {
  // Runs one claude mutator and reports whether it exited 0.
  mutate(args: string[]): boolean;
  readState(): ClaudeState;
}

function say(line: string): void {
  process.stdout.write(`reconcile-plugins: ${line}\n`);
}

// A version comes from Claude's list output; only a one-line string is printed.
function shown(version: unknown): string {
  return safeString(version) ? version : "unknown";
}

export function parseVersionManifest(raw: unknown): Map<string, string> {
  if (!isRecord(raw) || !isRecord(raw.versions)) {
    throw new ReconcileError("plugin version manifest must contain a versions object");
  }
  const reviewed = new Map<string, string>();
  for (const [id, version] of Object.entries(raw.versions)) {
    if (!PLUGIN_ID.test(id)) throw new ReconcileError("plugin version manifest contains an invalid plugin id");
    if (!safeString(version)) throw new ReconcileError(`plugin version manifest contains an invalid version: ${id}`);
    reviewed.set(id, version);
  }
  return reviewed;
}

function isNewer(left: string, right: string): boolean {
  const reference = right.split(".").map(Number);
  for (const [index, part] of left.split(".").map(Number).entries()) {
    if (part !== reference[index]) return part > reference[index];
  }
  return false;
}

// Only two release numbers can be ordered. A commit id, `unknown` or a missing
// version says no more than that it is not the reviewed one.
export function needsRaise(installed: unknown, reviewed: string): boolean {
  if (installed === reviewed) return false;
  const ordered = typeof installed === "string" && SEMVER.test(installed) && SEMVER.test(reviewed);
  return !(ordered && isNewer(installed, reviewed));
}

export function raiseTargets(state: ClaudeState, reviewed: Map<string, string>, claudeHome: string): RaiseTarget[] {
  const targets: RaiseTarget[] = [];
  const foreign: string[] = [];
  for (const [id, version] of reviewed) {
    const entry = userPluginEntry(state, id);
    if (!entry || !needsRaise(entry.version, version)) continue;
    if (insideRoot(entry.installPath, claudeHome)) {
      targets.push({ id, marketplace: id.slice(id.indexOf("@") + 1), installed: entry.version, reviewed: version });
    } else foreign.push(id);
  }
  if (foreign.length > 0) say(`not raised, installed outside this Claude home: ${foreign.join(", ")}`);
  return targets;
}

function raised(target: RaiseTarget, state: ClaudeState, ok: boolean): boolean {
  const entry = userPluginEntry(state, target.id);
  const before = shown(target.installed);
  if (entry && entry.version !== target.installed) {
    say(`raised plugin ${target.id} from ${before} to ${shown(entry.version)} (reviewed ${target.reviewed})`);
    return true;
  }
  if (entry && ok) say(`plugin ${target.id} is current at its marketplace (installed ${before}, reviewed ${target.reviewed})`);
  return entry !== undefined && ok;
}

// Returns what could not be raised. Every target is attempted first, so one
// refused update never holds the others back.
export function raisePlugins(
  state: ClaudeState, reviewed: Map<string, string>, claudeHome: string, actions: RaiseActions,
): string[] {
  const targets = raiseTargets(state, reviewed, claudeHome);
  if (targets.length === 0) return [];
  const refreshed = new Map<string, boolean>();
  for (const { marketplace } of targets) {
    if (!refreshed.has(marketplace)) {
      say(`update marketplace ${marketplace}`);
      refreshed.set(marketplace, actions.mutate(["plugin", "marketplace", "update", marketplace]));
    }
  }
  const attempts = targets.map((target) => {
    say(`update plugin ${target.id}`);
    const updated = actions.mutate(["plugin", "update", "--scope", "user", target.id]);
    return { target, ok: updated && refreshed.get(target.marketplace) === true };
  });
  const current = actions.readState();
  return attempts.filter(({ target, ok }) => !raised(target, current, ok))
    .map(({ target }) => `${target.id} (installed ${shown(target.installed)}, reviewed ${target.reviewed})`);
}
