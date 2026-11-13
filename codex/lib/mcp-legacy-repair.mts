import path from "node:path";

import type { McpProjection } from "./contracts.mts";
import { mcpTableRange, removeMcpTables } from "./managed-config.mts";

export interface RegistryTableRepairOptions {
  name: string;
  expectedNode: string;
  expectedBridge: string;
  expectedRegistry: string;
  expectedSourceName: string;
  oldPrefix: string;
  newPrefix: string;
  startMarker: string;
  endMarker: string;
}

interface StringValue { raw: string; value: string }
interface OwnedTable {
  base: { start: number; end: number; text: string };
  env?: { start: number; end: number; text: string };
}

function stringValue(raw: string): StringValue | undefined {
  const text = raw.trim();
  if (/^'(?:[^']*)'$/.test(text)) return { raw: text, value: text.slice(1, -1) };
  if (!/^"(?:\\.|[^"\\])*"$/.test(text)) return undefined;
  try { return { raw: text, value: JSON.parse(text) as string }; }
  catch { return undefined; }
}

function assignment(text: string, key: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(`^[\\t ]*${key}[\\t ]*=[\\t ]*(.+?)[\\t ]*$`, "gm"))];
  return matches.length === 1 ? matches[0][1] : undefined;
}

function validOptionalBoolean(text: string, key: string): boolean {
  const matches = [...text.matchAll(new RegExp(`^[\\t ]*${key}[\\t ]*=[\\t ]*(.+?)[\\t ]*$`, "gm"))];
  return matches.length === 0 || (matches.length === 1 && /^(?:true|false)$/.test(matches[0][1]));
}

function singleArg(text: string): StringValue | undefined {
  const value = assignment(text, "args")?.trim();
  if (!value?.startsWith("[") || !value.endsWith("]")) return undefined;
  return stringValue(value.slice(1, -1));
}

function samePath(left: string, right: string): boolean {
  const windows = /^[A-Za-z]:[\\/]/.test(right);
  const normalize = (value: string): string => value.replaceAll("\\", "/");
  return windows ? normalize(left).toLowerCase() === normalize(right).toLowerCase() : left === right;
}

function inlineEnv(text: string, prefix: string): Record<string, StringValue> | undefined {
  const match = /^[\t ]*env[\t ]*=[\t ]*\{([^\r\n]*)\}[\t ]*$/m.exec(text);
  if (!match) return undefined;
  const values: Record<string, StringValue> = {};
  let rest = match[1];
  while (rest.trim()) {
    const item = /^\s*(?:,\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*/.exec(rest);
    if (!item || (Object.keys(values).length > 0 && !/^\s*,/.test(rest))) return undefined;
    const parsed = stringValue(item[2]);
    if (!parsed || values[item[1]]) return undefined;
    values[item[1]] = parsed;
    rest = rest.slice(item[0].length);
  }
  return Object.keys(values).length === 3 ? values : undefined;
}

function subtableEnv(text: string, name: string, prefix: string): Record<string, StringValue> | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${escaped}\\s*\\.\\s*env\\s*\\]\\s*$`);
  const values: Record<string, StringValue> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || header.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*$/.exec(line);
    const parsed = match && stringValue(match[2]);
    if (!match || !parsed || values[match[1]]) return undefined;
    values[match[1]] = parsed;
  }
  return Object.keys(values).length === 3 ? values : undefined;
}

function ownedTable(config: string, options: RegistryTableRepairOptions): OwnedTable | undefined {
  const base = mcpTableRange(config, options.name);
  if (!base) return undefined;
  const managedStart = config.indexOf(options.startMarker);
  const managedEnd = config.indexOf(options.endMarker);
  if (managedStart >= 0 && managedEnd > managedStart
      && base.start > managedStart && base.start < managedEnd) return undefined;
  const command = assignment(base.text, "command");
  const parsedCommand = command ? stringValue(command) : undefined;
  const arg = singleArg(base.text);
  if (!parsedCommand || !arg
      || !samePath(parsedCommand.value, options.expectedNode)
      || !samePath(arg.value, options.expectedBridge)
      || !validOptionalBoolean(base.text, "enabled")
      || !validOptionalBoolean(base.text, "required")) return undefined;
  const env = mcpTableRange(config, `${options.name}.env`);
  const inline = inlineEnv(base.text, options.oldPrefix);
  const values = inline || (env && subtableEnv(env.text, options.name, options.oldPrefix));
  const inlineEnvCount = [...base.text.matchAll(/^[\t ]*env[\t ]*=/gm)].length;
  if (!values || (inline && env) || (inline && inlineEnvCount !== 1)
      || (!inline && inlineEnvCount !== 0) || (env && env.start !== base.end)) return undefined;
  const expectedKeys = ["MCP_REGISTRY_FILE", "MCP_SERVER_NAME", "MCP_ALLOW_INSECURE_HTTP"]
    .map((suffix) => `${options.oldPrefix}${suffix}`);
  if (Object.keys(values).length !== expectedKeys.length
      || !expectedKeys.every((key) => values[key])
      || !samePath(values[`${options.oldPrefix}MCP_REGISTRY_FILE`].value, options.expectedRegistry)
      || values[`${options.oldPrefix}MCP_SERVER_NAME`].value !== options.expectedSourceName
      || values[`${options.oldPrefix}MCP_ALLOW_INSECURE_HTTP`].value !== "1") return undefined;
  return { base, ...(!inline && env ? { env } : {}) };
}

function renameHeaders(config: string, oldName: string, newName: string, options: RegistryTableRepairOptions): string {
  if (oldName === newName) return config;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^(\\s*\\[\\s*mcp_servers\\s*\\.\\s*)${escaped}(?=\\s*(?:\\.|\\]))`, "gm");
  const managedStart = config.indexOf(options.startMarker);
  const managedEnd = config.indexOf(options.endMarker);
  return config.replace(header, (match, prefix: string, offset: number) => (
    managedStart >= 0 && managedEnd > managedStart && offset > managedStart && offset < managedEnd
      ? match : `${prefix}${newName}`
  ));
}

export function canonicalizeOwnedRegistryTable(
  config: string, options: RegistryTableRepairOptions,
): { config: string; migrated: boolean } {
  if (!/^[A-Za-z0-9._-]+$/.test(options.name)
      || !/^[A-Z][A-Z0-9_]*_$/.test(options.oldPrefix)
      || !/^[A-Z][A-Z0-9_]*_$/.test(options.newPrefix)) {
    throw new Error("Legacy MCP table repair options are invalid");
  }
  const owned = ownedTable(config, options);
  if (!owned || options.oldPrefix === options.newPrefix) return { config, migrated: false };
  const range = owned.env || owned.base;
  const rewritten = range.text.replace(
    new RegExp(`\\b${options.oldPrefix}(MCP_(?:REGISTRY_FILE|SERVER_NAME|ALLOW_INSECURE_HTTP))\\b`, "g"),
    `${options.newPrefix}$1`,
  );
  return {
    config: config.slice(0, range.start) + rewritten + config.slice(range.end),
    migrated: true,
  };
}

export function retireOwnedRegistryTable(
  config: string, options: RegistryTableRepairOptions,
): { config: string; migrated: boolean } {
  if (!ownedTable(config, options)) return { config, migrated: false };
  return { config: removeMcpTables(config, [options.name]), migrated: true };
}

export function replaceOwnedRegistryTransport(
  config: string,
  options: RegistryTableRepairOptions & { outputName: string; projection: McpProjection },
): { config: string; migrated: boolean } {
  const owned = ownedTable(config, options);
  const projection = options.projection;
  if (!owned || (projection.transport !== "http" && projection.transport !== "stdio")
      || (projection.transport === "http" && projection.authentication !== "native")) {
    return { config, migrated: false };
  }
  const newline = owned.base.text.includes("\r\n") ? "\r\n" : "\n";
  const lines = owned.base.text.split(/\r?\n/);
  const firstTransport = lines.findIndex((line) => /^\s*(?:command|args|env)\s*=/.test(line));
  const kept = lines.filter((line) => !/^\s*(?:command|args|env)\s*=/.test(line));
  const transport = projection.transport === "http"
    ? [`url = ${JSON.stringify(projection.url)}`]
    : [
      `command = ${JSON.stringify(projection.command)}`,
      `args = [${projection.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      ...(projection.env ? [`env = { ${Object.entries(projection.env)
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")} }`] : []),
    ];
  kept.splice(firstTransport, 0, ...transport);
  let next = config;
  if (owned.env) next = next.slice(0, owned.env.start) + next.slice(owned.env.end);
  next = next.slice(0, owned.base.start) + kept.join(newline) + next.slice(owned.base.end);
  next = renameHeaders(next, options.name, options.outputName, options);
  return { config: next, migrated: true };
}
