import fs from "node:fs";
import path from "node:path";

import { runCodex } from "./codex-cli.mts";
import type { RunCodex } from "./contracts.mts";

const OWNED_PLUGIN_ID = "kherep-maestro@kherep";
const OWNED_MARKETPLACE = "kherep";

export interface LocalPluginOptions {
  runCodex?: RunCodex;
  codexHome?: string;
  [key: string]: unknown;
}

interface MarketplaceEntry {
  name: string;
  root: string;
}

function marketplaceEntries(raw: string): MarketplaceEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Unexpected Codex marketplace list schema");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { marketplaces?: unknown }).marketplaces)) {
    throw new Error("Unexpected Codex marketplace list schema");
  }
  const entries = (parsed as { marketplaces: unknown[] }).marketplaces;
  if (!entries.every((entry) => entry && typeof entry === "object" &&
    typeof (entry as MarketplaceEntry).name === "string" && typeof (entry as MarketplaceEntry).root === "string")) {
    throw new Error("Unexpected Codex marketplace list schema");
  }
  return entries as MarketplaceEntry[];
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value.replace(/^\\\\\?\\/, "")).replace(/(?<![\\/])[\\/]+$/, "");
  const [a, b] = [normalize(left), normalize(right)];
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function tomlString(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'") && !value.slice(1, -1).includes("'")) {
    return value.slice(1, -1);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function structuralTomlLines(lines: string[]): boolean[] {
  let multiline: "'''" | '\"\"\"' | undefined;
  return lines.map((line) => {
    if (multiline) {
      const close = line.indexOf(multiline);
      if (close >= 0) multiline = undefined;
      return false;
    }
    let index = -1;
    while (++index < line.length) {
      const char = line[index];
      if (char === "#") break;
      if (line.startsWith("'''", index) || line.startsWith('\"\"\"', index)) {
        const marker = line.slice(index, index + 3) as "'''" | '\"\"\"';
        const close = line.indexOf(marker, index + 3);
        if (close < 0) multiline = marker;
        else index = close + 2;
        continue;
      }
      if (char !== "'" && char !== '"') continue;
      let escaped = false;
      while (++index < line.length) {
        if (char === '"' && escaped) escaped = false;
        else if (char === '"' && line[index] === "\\") escaped = true;
        else if (line[index] === char) break;
      }
    }
    return true;
  });
}

function ownedLocalSource(codexHome: string | undefined, marketplace: string, listedRoot: string): string {
  if (!codexHome) throw new Error("Codex home is required to verify the owned marketplace source");
  let config: string;
  try {
    config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    throw new Error("Unable to read the owned marketplace source metadata");
  }
  const escaped = marketplace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[marketplaces\\.(?:${escaped}|"${escaped}"|'${escaped}')\\]\\s*(?:#.*)?$`);
  const sections: Array<{ start: number; end: number }> = [];
  const lines = config.split(/\r?\n/);
  const structural = structuralTomlLines(lines);
  let index = -1;
  while (++index < lines.length) {
    if (!structural[index] || !header.test(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && !(structural[end] && /^\s*\[/.test(lines[end]))) end += 1;
    sections.push({ start: index + 1, end });
    index = end - 1;
  }
  if (sections.length !== 1) throw new Error("Owned marketplace source metadata is missing or ambiguous");
  const values = new Map<string, string>();
  for (let index = sections[0].start; index < sections[0].end; index += 1) {
    if (!structural[index]) continue;
    const line = lines[index];
    const match = line.match(/^\s*(source_type|source)\s*=\s*((?:"(?:\\.|[^"\\])*")|(?:'[^']*'))\s*(?:#.*)?$/);
    if (!match) continue;
    if (values.has(match[1])) throw new Error("Owned marketplace source metadata is ambiguous");
    const decoded = tomlString(match[2]);
    if (decoded === undefined) throw new Error("Owned marketplace source metadata is unsupported");
    values.set(match[1], decoded);
  }
  if (values.get("source_type") !== "local") throw new Error("The owned marketplace source is not local");
  const source = values.get("source");
  if (!source || !samePath(source, listedRoot)) {
    throw new Error("Owned marketplace source metadata does not match the CLI root");
  }
  return source;
}

function marketplaceManifestName(root: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(root, ".agents", "plugins", "marketplace.json"),
      "utf8",
    )) as { name?: unknown };
    if (manifest.name === OWNED_MARKETPLACE) return manifest.name;
  } catch {
    // Report one stable error below without leaking source paths or parser details.
  }
  throw new Error("Owned marketplace manifest identity is missing or unsupported");
}

function addMarketplace(invoke: RunCodex, root: string): void {
  invoke(
    ["plugin", "marketplace", "add", `./${path.basename(root)}`, "--json"],
    { cwd: path.dirname(root) },
  );
}

function removeMarketplace(invoke: RunCodex, marketplace = OWNED_MARKETPLACE): void {
  invoke(["plugin", "marketplace", "remove", marketplace, "--json"]);
}

export function ownedPluginConfig(config: string): { config: string; preferredEnabled: boolean } {
  const lines = config.split(/\r?\n/);
  const structural = structuralTomlLines(lines);
  const headerFor = (id: string): RegExp => new RegExp(
    `^\\s*\\[plugins\\.${JSON.stringify(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*(?:#.*)?$`,
  );
  const indexes = (id: string): number[] => lines
    .map((line, index) => structural[index] && headerFor(id).test(line) ? index : -1)
    .filter((index) => index >= 0);
  const current = indexes(OWNED_PLUGIN_ID);
  if (current.length > 1) throw new Error("Ambiguous owned plugin table");
  const table = current[0];
  if (table === undefined) return { config, preferredEnabled: true };
  let end = lines.length;
  for (let index = table + 1; index < lines.length; index += 1) {
    if (structural[index] && /^\s*\[/.test(lines[index])) { end = index; break; }
  }
  const enabled = lines.slice(table + 1, end)
    .filter((line, index) => structural[table + 1 + index] && /^\s*enabled\s*=/.test(line));
  if (enabled.length > 1 || (enabled[0] && !/^\s*enabled\s*=\s*(?:true|false)\s*(?:#.*)?$/.test(enabled[0]))) {
    throw new Error("Ambiguous owned plugin enabled setting");
  }
  const enabledValue = enabled[0]?.match(/^\s*enabled\s*=\s*(true|false)\b/);
  const preferredEnabled = enabledValue ? enabledValue[1] === "true" : true;
  return { config: lines.join(config.includes("\r\n") ? "\r\n" : "\n"), preferredEnabled };
}

export function registerLocalPlugin(marketplaceRoot: string, pluginId: string, options: LocalPluginOptions = {}): void {
  if (pluginId !== OWNED_PLUGIN_ID) throw new Error("Unsupported local plugin registration");
  const invoke: RunCodex = options.runCodex || ((args, commandOptions = {}) => (
    runCodex(args, { ...options, ...commandOptions })
  ));
  const entries = marketplaceEntries(invoke(["plugin", "marketplace", "list", "--json"], { stdoutOnly: true }));
  const owned = entries.filter((entry) => entry.name === OWNED_MARKETPLACE);
  if (owned.length > 1) throw new Error("Codex returned conflicting owned marketplace bindings");
  const previousName = owned[0]?.name;
  const previousRoot = owned[0]?.root;
  if (previousName === OWNED_MARKETPLACE && previousRoot && samePath(previousRoot, marketplaceRoot)) {
    invoke(["plugin", "add", pluginId]);
    return;
  }

  const previousSource = previousRoot && previousName
    ? ownedLocalSource(options.codexHome, previousName, previousRoot)
    : undefined;
  const previousManifestName = previousSource && samePath(previousSource, marketplaceRoot)
    ? marketplaceManifestName(previousSource)
    : previousName;

  let addedDesired = false;
  if (previousRoot && previousName) removeMarketplace(invoke, previousName);
  try {
    addMarketplace(invoke, marketplaceRoot);
    addedDesired = true;
    invoke(["plugin", "add", pluginId]);
  } catch (error) {
    try {
      if (addedDesired) removeMarketplace(invoke);
      if (previousSource && previousManifestName === previousName) addMarketplace(invoke, previousSource);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Local plugin registration and marketplace restoration failed");
    }
    throw error;
  }
}
