import fs from "node:fs";
import path from "node:path";

import { isRecord } from "./shape.mts";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Scopes Claude reports and this contract knows. Kherep mutates only `user`
// (see userPluginEntry); `project`, `local` and `synced` rows are read for
// duplicate detection and never installed, enabled or removed. `synced` is
// written by claude.ai (issue #338). A declared plugin present only in one of
// those scopes still gets its own user-scope copy: Kherep must not touch the
// other row, so it cannot otherwise keep the plugin usable. A well-formed row
// with any other scope is handed to the caller and skipped.
const KNOWN_SCOPES = new Set(["user", "project", "local", "synced"]);

export class ReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileError";
  }
}

// One entry of bootstrap/manifest/marketplaces.json after validation: the
// canonical form is what live state is compared against, `ref` is what gets
// handed to `claude plugin marketplace add`.
export interface MarketplaceExpectation {
  name: string;
  source: "github" | "git";
  field: "repo" | "url";
  canonical: string;
  ref: string;
}

// Rows of `claude plugin marketplace list --json` / `claude plugin list --json`.
// Only the fields the contract reads are typed; Claude may add more.
export interface MarketplaceEntry {
  name: string;
  source: string;
  [key: string]: unknown;
}

export interface PluginEntry {
  id: string;
  scope: string;
  enabled: boolean;
  installPath: string;
  [key: string]: unknown;
}

export interface ClaudeState {
  marketplaces: Map<string, MarketplaceEntry>;
  plugins: Map<string, PluginEntry>;
}

function fail(message: string): never {
  throw new ReconcileError(message);
}

export function safeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value);
}

function canonicalRepo(value: unknown): string | null {
  return safeString(value) && SAFE_REPO.test(value) ? value.toLowerCase() : null;
}

function canonicalHttpsUrl(value: unknown): string | null {
  if (!safeString(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) {
    return null;
  }
  let pathname = url.pathname;
  if (pathname.length > 1) pathname = pathname.replace(/(?<!\/)\/+$/, "");
  return `https://${url.host.toLowerCase()}${pathname}`;
}

export function parseMarketplaceManifest(raw: unknown): MarketplaceExpectation[] {
  if (!isRecord(raw)) fail("marketplaces manifest must be an object");
  const marketplaces: MarketplaceExpectation[] = [];
  for (const [name, definition] of Object.entries(raw)) {
    if (!SAFE_NAME.test(name)) fail("marketplaces manifest contains an invalid name");
    if (!isRecord(definition) || !isRecord(definition.source)) {
      fail(`invalid marketplace definition: ${name}`);
    }
    const source = definition.source;
    const hasRepo = Object.prototype.hasOwnProperty.call(source, "repo");
    const hasUrl = Object.prototype.hasOwnProperty.call(source, "url");
    if (hasRepo === hasUrl) fail(`marketplace must define exactly one source: ${name}`);
    if (hasRepo) {
      const ref = source.repo;
      const canonical = canonicalRepo(ref);
      if (source.source !== "github" || canonical === null || typeof ref !== "string") {
        fail(`invalid GitHub marketplace source: ${name}`);
      }
      marketplaces.push({ name, source: "github", field: "repo", canonical, ref });
    } else {
      const ref = source.url;
      const canonical = canonicalHttpsUrl(ref);
      if (source.source !== "git" || canonical === null || typeof ref !== "string") {
        fail(`invalid HTTPS marketplace source: ${name}`);
      }
      marketplaces.push({ name, source: "git", field: "url", canonical, ref });
    }
  }
  return marketplaces;
}

export function parsePluginManifest(raw: unknown, marketplaceNames: Set<string>): string[] {
  if (!isRecord(raw) || !isRecord(raw.enabledPlugins)) {
    fail("plugins manifest must contain an enabledPlugins object");
  }
  const required: string[] = [];
  for (const [id, enabled] of Object.entries(raw.enabledPlugins)) {
    if (typeof enabled !== "boolean") fail("plugins manifest contains a non-boolean flag");
    const match = id.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9._-]*)$/);
    if (!match) fail("plugins manifest contains an invalid plugin id");
    if (enabled === true) {
      if (!marketplaceNames.has(match[2])) {
        fail(`required plugin references an unknown marketplace: ${id}`);
      }
      required.push(id);
    }
  }
  return required;
}

// Rows of the Claude list output are kept by reference; the predicates name
// exactly the fields the entry types declare.
function isMarketplaceEntry(entry: unknown): entry is MarketplaceEntry {
  return isRecord(entry) && safeString(entry.name) && SAFE_NAME.test(entry.name) && safeString(entry.source);
}

function isPluginEntry(entry: unknown): entry is PluginEntry {
  return isRecord(entry) && safeString(entry.id) && safeString(entry.scope) && SAFE_NAME.test(entry.scope)
    && typeof entry.enabled === "boolean" && safeString(entry.installPath);
}

export function parseMarketplaceList(raw: unknown): Map<string, MarketplaceEntry> {
  if (!Array.isArray(raw)) fail("Claude marketplace list JSON must be an array");
  const byName = new Map<string, MarketplaceEntry>();
  for (const entry of raw as unknown[]) {
    if (!isMarketplaceEntry(entry)) fail("Claude marketplace list contains a malformed entry");
    if (byName.has(entry.name)) fail(`Claude marketplace list contains a duplicate: ${entry.name}`);
    byName.set(entry.name, entry);
  }
  return byName;
}

// `onUnmanaged` receives each well-formed row whose scope is not known; the
// row is left out of the result so no lookup can act on it.
export function parsePluginList(
  raw: unknown,
  onUnmanaged: (entry: PluginEntry) => void = () => {},
): Map<string, PluginEntry> {
  if (!Array.isArray(raw)) fail("Claude plugin list JSON must be an array");
  const byIdAndScope = new Map<string, PluginEntry>();
  for (const entry of raw as unknown[]) {
    if (!isPluginEntry(entry)) fail("Claude plugin list contains a malformed entry");
    if (!KNOWN_SCOPES.has(entry.scope)) {
      onUnmanaged(entry);
      continue;
    }
    const key = `${entry.id}\0${entry.scope}`;
    if (byIdAndScope.has(key)) fail("Claude plugin list contains a duplicate id/scope entry");
    byIdAndScope.set(key, entry);
  }
  return byIdAndScope;
}

export function marketplaceMatches(entry: MarketplaceEntry | undefined, expected: MarketplaceExpectation): boolean {
  if (!entry || entry.source !== expected.source) return false;
  return expected.field === "repo"
    ? canonicalRepo(entry.repo) === expected.canonical
    : canonicalHttpsUrl(entry.url) === expected.canonical;
}

export function assertNoMarketplaceCollision(state: ClaudeState, expected: MarketplaceExpectation): void {
  const entry = state.marketplaces.get(expected.name);
  if (entry && !marketplaceMatches(entry, expected)) {
    fail(`marketplace source collision: ${expected.name}`);
  }
}

function installPathIsDirectory(entry: PluginEntry | undefined): boolean {
  if (!entry || !path.isAbsolute(entry.installPath)) return false;
  try {
    return fs.statSync(entry.installPath).isDirectory();
  } catch {
    return false;
  }
}

function userPluginEntry(state: ClaudeState, id: string): PluginEntry | undefined {
  return state.plugins.get(`${id}\0user`);
}

export function pluginInstalled(state: ClaudeState, id: string): boolean {
  return installPathIsDirectory(userPluginEntry(state, id));
}

export function pluginSatisfied(state: ClaudeState, id: string): boolean {
  const entry = userPluginEntry(state, id);
  return entry !== undefined && installPathIsDirectory(entry) && entry.enabled === true;
}

export function verifyFinalState(state: ClaudeState, marketplaces: MarketplaceExpectation[], requiredPlugins: string[]): void {
  for (const expected of marketplaces) {
    assertNoMarketplaceCollision(state, expected);
    if (!marketplaceMatches(state.marketplaces.get(expected.name), expected)) {
      fail(`required marketplace missing: ${expected.name}`);
    }
  }
  for (const id of requiredPlugins) {
    if (!pluginSatisfied(state, id)) fail(`required plugin is not usable: ${id}`);
  }
}
