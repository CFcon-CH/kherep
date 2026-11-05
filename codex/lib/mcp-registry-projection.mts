import fs from "node:fs";
import path from "node:path";

import type { McpProjection } from "./contracts.mts";

const CODEBASE_MEMORY_NAME = "codebase-memory-mcp";
const CODEBASE_MEMORY_EXECUTABLE = /^codebase-memory-mcp(?:\.exe)?$/i;
const STDIO_FIELDS = new Set(["type", "command", "args", "env"]);
const HTTP_FIELDS = new Set(["type", "url", "headers"]);

export interface RegistryProjectionOptions {
  sourceNames?: Record<string, string>;
  legacyRegistryAdapters?: { node: string; bridge: string; envPrefix: string }[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(name: string, reason: string): never {
  throw new Error(`MCP server ${name}: ${reason}`);
}

function httpProjection(name: string, sourceName: string, server: Record<string, unknown>): McpProjection {
  if (Object.keys(server).some((key) => !HTTP_FIELDS.has(key))) fail(name, "HTTP fields are unsupported");
  let endpoint: URL;
  try { endpoint = new URL(String(server.url || "")); } catch { fail(name, "HTTP endpoint is invalid"); }
  if (endpoint.username || endpoint.password) fail(name, "HTTP endpoint is invalid");
  if (server.headers !== undefined && !plainObject(server.headers)) fail(name, "HTTP headers are invalid");
  const headerKeys = server.headers === undefined ? [] : Object.keys(server.headers);
  if (headerKeys.length) {
    const authorization = server.headers?.Authorization;
    if (headerKeys.length !== 1 || typeof authorization !== "string"
        || !/^Bearer [^\s]{16,}$/.test(authorization) || /[\r\n]/.test(authorization)
        || !["http:", "https:"].includes(endpoint.protocol)) {
      fail(name, "HTTP authentication is unsupported");
    }
    return { name, transport: "http", authentication: "registry-bearer", sourceName };
  }
  const host = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))
      || endpoint.search || endpoint.hash) {
    fail(name, "HTTP endpoint is invalid");
  }
  return { name, transport: "http", authentication: "native", url: endpoint.href };
}

function samePath(left: unknown, right: string): boolean {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isLegacyRegistryAdapter(
  server: Record<string, unknown>, file: string, sourceName: string,
  options: RegistryProjectionOptions,
): boolean {
  const adapters = options.legacyRegistryAdapters || [];
  return adapters.some((adapter) => {
    if (!path.isAbsolute(adapter.node) || !path.isAbsolute(adapter.bridge)
        || !/^[A-Z][A-Z0-9_]*_$/.test(adapter.envPrefix)) {
      throw new Error("Legacy MCP adapter options are invalid");
    }
    const expectedEnv: Record<string, string> = {
      [`${adapter.envPrefix}MCP_REGISTRY_FILE`]: file,
      [`${adapter.envPrefix}MCP_SERVER_NAME`]: sourceName,
      [`${adapter.envPrefix}MCP_ALLOW_INSECURE_HTTP`]: "1",
    };
    if (!samePath(server.command, adapter.node) || !Array.isArray(server.args)
        || server.args.length !== 1 || !samePath(server.args[0], adapter.bridge)
        || !plainObject(server.env)) return false;
    const env = server.env as Record<string, unknown>;
    const keys = Object.keys(env).sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
    const expectedKeys = Object.keys(expectedEnv).sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
    return keys.length === expectedKeys.length
      && keys.every((key, index) => key === expectedKeys[index] && env[key] === expectedEnv[key]);
  });
}

export function classifyServer(
  name: string, server: unknown,
  context?: { file: string; sourceName: string; options: RegistryProjectionOptions },
): McpProjection {
  if (!/^[A-Za-z0-9._-]+$/.test(String(name))) {
    throw new Error("MCP server name is invalid");
  }
  if (server === undefined) return { name, transport: "missing" };
  if (!plainObject(server)) fail(name, "server definition is invalid");
  if (server.type === "http") return httpProjection(name, context?.sourceName ?? name, server);
  if (server.type !== undefined && server.type !== "stdio") fail(name, "transport is unsupported");

  if (Object.keys(server).some((key) => !STDIO_FIELDS.has(key))) fail(name, "stdio fields are unsupported");
  if (typeof server.command !== "string" || !server.command.trim()) fail(name, "stdio command is invalid");
  const args = server.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    fail(name, "stdio arguments are invalid");
  }
  if (server.env !== undefined && !plainObject(server.env)) fail(name, "stdio environment is invalid");
  if (context && isLegacyRegistryAdapter(server, context.file, context.sourceName, context.options)) {
    return { name, transport: "legacy-registry-adapter" };
  }
  if (name !== CODEBASE_MEMORY_NAME) return { name, transport: "unsupported-stdio" };
  if (server.env !== undefined && Object.keys(server.env).length) {
    fail(name, "stdio environment is not secret-safe");
  }
  if (!path.isAbsolute(server.command) || !CODEBASE_MEMORY_EXECUTABLE.test(path.basename(server.command))) {
    fail(name, "stdio command is unsupported");
  }
  if (args.length) fail(name, "stdio arguments are not secret-safe");
  return { name, transport: "stdio", command: server.command, args: [] };
}

export function projectRegistry(
  file: string, names: string[], options: RegistryProjectionOptions = {},
): McpProjection[] {
  if (!path.isAbsolute(String(file || ""))) throw new Error("MCP registry path must be absolute");
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 2_000_000) throw new Error("MCP registry file is invalid");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("MCP registry file is not private");
  }

  let registry: unknown;
  try {
    registry = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("MCP registry JSON is invalid");
  }
  if (!plainObject(registry) || (registry.mcpServers !== undefined && !plainObject(registry.mcpServers))) {
    throw new Error("MCP registry structure is invalid");
  }
  const servers = registry.mcpServers;
  return names.map((name) => {
    if (!/^[A-Za-z0-9._-]+$/.test(String(name))) throw new Error("MCP server name is invalid");
    const sourceName = options.sourceNames?.[name] ?? name;
    if (!/^[A-Za-z0-9._-]+$/.test(String(sourceName))) throw new Error("MCP source name is invalid");
    return classifyServer(name, servers?.[sourceName], { file, sourceName, options });
  });
}
