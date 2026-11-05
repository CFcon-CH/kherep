#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { errorMessage, isRecord } from "./shape.mts";

// A Claude MCP registry (~/.claude.json or a .mcp.json). Only `mcpServers` is
// interpreted; every other key travels through the migration untouched.
export interface Registry {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readRegistry(file: string): Registry {
  const resolved = path.resolve(file);
  if (process.platform !== "win32") {
    let real: string;
    try { real = fs.realpathSync(resolved); }
    catch { throw new Error("input registry cannot be opened safely"); }
    if (real !== resolved) throw new Error("input registry path must not contain symbolic links");
  }

  let descriptor: number | undefined;
  let raw: string;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("input registry must be a regular file");
    raw = fs.readFileSync(descriptor, "utf8");
  } catch (error) {
    if (errorMessage(error) === "input registry must be a regular file") throw error;
    throw new Error("input registry cannot be read safely");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("input registry is not valid JSON"); }
  if (!isRecord(value)) throw new Error("registry must be an object");
  return value;
}

export function migrateRegistry(registry: Registry, serverName: string): Registry {
  if (!/^[A-Za-z0-9._-]+$/.test(serverName)) throw new Error("invalid MCP server name");
  const servers = registry.mcpServers;
  const server = servers && servers[serverName];
  if (!isRecord(server)) throw new Error("MCP server is missing");
  const keys = Object.keys(server).sort((left, right) => Number(left > right) - Number(left < right));
  if (keys.some((key) => !["args", "command", "env"].includes(key))) {
    throw new Error("stdio server has unsupported fields");
  }
  if (server.command !== "npx" || !Array.isArray(server.args)) throw new Error("server is not an npx stdio bridge");
  if (Object.prototype.hasOwnProperty.call(server, "env")
      && (!isRecord(server.env) || Object.getPrototypeOf(server.env) !== Object.prototype
        || Object.keys(server.env).length)) {
    throw new Error("stdio bridge environment must be absent or an empty object");
  }
  const args: unknown[] = server.args;
  if (args.length !== 6 || args[0] !== "-y" || args[1] !== "supergateway"
      || args[2] !== "--streamableHttp" || args[4] !== "--header") {
    throw new Error("stdio bridge arguments do not match the supported contract");
  }
  let endpoint: URL;
  try { endpoint = new URL(String(args[3])); } catch { throw new Error("stdio bridge endpoint is invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("stdio bridge endpoint must be credential-free HTTPS");
  }
  const auth = /^authorization\s*:\s*Bearer\s+([^\s]+)\s*$/i.exec(String(args[5]));
  if (!auth || auth[1].length < 32) throw new Error("stdio bridge bearer header is invalid");

  const output: Registry = JSON.parse(JSON.stringify(registry));
  output.mcpServers = {
    ...output.mcpServers,
    [serverName]: {
      type: "http",
      url: endpoint.toString(),
      headers: { Authorization: `Bearer ${auth[1]}` },
    },
  };
  return output;
}

export function writeFreshText(file: string, text: string): void {
  const parent = path.dirname(path.resolve(file));
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("output parent must be a real directory");
  if (process.platform !== "win32" && fs.realpathSync(parent) !== parent) {
    throw new Error("output parent path must not contain symbolic links");
  }

  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    created = true;
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
      descriptor = undefined;
    }
    if (created) {
      try { fs.unlinkSync(file); } catch {}
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeFresh(file: string, value: unknown): void {
  writeFreshText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function main(args: string[]): void {
  const [input, output, serverName] = args;
  if (!input || !output || !serverName || path.resolve(input) === path.resolve(output)) {
    throw new Error("usage: <input-registry> <fresh-output> <server-name>");
  }
  writeFresh(output, migrateRegistry(readRegistry(input), serverName));
  process.stdout.write(`MCP transport hardened: ${serverName} -> native HTTP\n`);
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`MCP migration failed: ${errorMessage(error)}\n`); process.exitCode = 1; }
}
