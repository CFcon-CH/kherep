import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stableNodePath } from "./node-path.mts";

export interface RegistryOptions {
  claudeRegistryFile?: string;
  registryBridge: string;
  nodePath?: string;
  [key: string]: unknown;
}

export interface RegistryResolution {
  bridge: string;
  node: string;
  registry: string;
}

function tomlString(value: unknown): string {
  return JSON.stringify(String(value));
}

export function resolveRegistry(options: RegistryOptions): RegistryResolution {
  const registry = path.resolve(options.claudeRegistryFile || path.join(os.homedir(), ".claude.json"));
  const bridge = path.resolve(options.registryBridge);
  const node = options.nodePath ? path.resolve(options.nodePath) : stableNodePath(process.execPath);
  for (const [label, target] of [["Claude MCP registry", registry], ["Node runtime", node]]) {
    if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${label} not found: ${target}`);
    }
  }
  return { bridge, node, registry };
}


function unmanagedPart(config: string, startMarker: string, endMarker: string): string {
  const start = config.indexOf(startMarker);
  const end = config.indexOf(endMarker);
  return start >= 0 && end > start
    ? config.slice(0, start) + config.slice(end + endMarker.length)
    : config;
}

export function hasUnmanagedMcp(config: string, name: string, startMarker: string, endMarker: string): boolean {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const table = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*["']?${escaped}["']?\\s*\\]\\s*(?:#.*)?$`,
    "m",
  );
  return table.test(unmanagedPart(config, startMarker, endMarker));
}

export function assertNoUnmanagedMcp(config: string, names: string[], startMarker: string, endMarker: string): void {
  for (const name of names) {
    if (hasUnmanagedMcp(config, name, startMarker, endMarker)) {
      throw new Error(`Refusing to overwrite unmanaged MCP table: mcp_servers.${name}`);
    }
  }
}

// The lines of config with their line ends. Text up to a U+2028 or U+2029 belongs to no line.
function tomlLines(config: string): string[] {
  const source = String(config);
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\u2028" || char === "\u2029") { start = i + 1; continue; }
    if (char !== "\n" && char !== "\r") continue;
    if (char === "\r" && source[i + 1] === "\n") i += 1;
    lines.push(source.slice(start, i + 1));
    start = i + 1;
  }
  if (start < source.length) lines.push(source.slice(start));
  return lines;
}

export function mcpTableRange(config: string, name: string): { start: number; end: number; text: string } | undefined {
  const source = String(config);
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*["']?${escaped}["']?\\s*\\]\\s*(?:#.*)?$`,
  );
  let offset = 0;
  let start = -1;
  for (const line of tomlLines(source)) {
    const content = line.replace(/(?:\r\n|\n|\r)$/, "");
    if (start >= 0 && /^\s*(?:\[[^[\]]+\]|\[\[[^[\]]+\]\])\s*(?:#.*)?$/.test(content)) {
      return { start, end: offset, text: source.slice(start, offset) };
    }
    if (start < 0 && header.test(content)) start = offset;
    offset += line.length;
  }
  return start >= 0 ? { start, end: source.length, text: source.slice(start) } : undefined;
}

export function removeExactUnmanagedMcp(
  config: string, name: string, expected: string, startMarker: string, endMarker: string,
): { config: string; removed: boolean } {
  const source = String(config);
  const range = mcpTableRange(source, name);
  if (!range) return { config: source, removed: false };
  const managedStart = source.indexOf(startMarker);
  const managedEnd = source.indexOf(endMarker);
  if (managedStart >= 0 && managedEnd > managedStart
      && range.start > managedStart && range.start < managedEnd) {
    return { config: source, removed: false };
  }
  if (range.text.trim() !== String(expected).trim()) return { config: source, removed: false };
  return {
    config: source.slice(0, range.start) + source.slice(range.end),
    removed: true,
  };
}

export function removeMcpTables(config: string, names: string[]): string {
  const patterns = names.map((name) => {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*["']?${escaped}["']?(?:\\s*\\.\\s*[^\\]]+)?\\s*\\]\\s*(?:#.*)?$`,
    );
  });
  let removing = false;
  return tomlLines(config).filter((line) => {
    const content = line.replace(/(?:\r\n|\n|\r)$/, "");
    if (/^\s*(?:\[[^[\]]+\]|\[\[[^[\]]+\]\])\s*(?:#.*)?$/.test(content)) {
      removing = patterns.some((pattern) => pattern.test(content));
    }
    return !removing;
  }).join("");
}
