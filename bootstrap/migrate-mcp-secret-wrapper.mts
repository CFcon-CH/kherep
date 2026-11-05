#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readRegistry, writeFresh, writeFreshText, type Registry } from "./migrate-mcp-http-auth.mts";
import { errorMessage, isRecord } from "./shape.mts";

export interface WrapperMigration {
  registry: Registry;
  // Absent when the entry already ran through the wrapper and only its path
  // moved (OP-1123: supergateway-secret-wrapper.js -> .mts); the installed
  // token file stays untouched then.
  token?: string;
}

const WRAPPER_FILE = /[\\/]supergateway-secret-wrapper\.(?:js|mts)$/;
const WRAPPER_ENV = ["KHEREP_MCP_AUTH_FILE", "KHEREP_MCP_ENDPOINT", "NODE_TLS_REJECT_UNAUTHORIZED"];
const LEGACY_WRAPPER_ENV = ["KHEREP_MCP_AUTH_FILE", "KHEREP_MCP_ENDPOINT", "NODE_TLS_REJECT_UNAUTHORIZED"];

function isAbsolute(file: string): boolean {
  return path.posix.isAbsolute(file) || path.win32.isAbsolute(file);
}

export function migrateRegistry(
  registry: Registry, serverName: string, wrapperPath: string, installedTokenPath: string,
): WrapperMigration {
  if (!/^[A-Za-z0-9._-]+$/.test(serverName)) throw new Error("invalid MCP server name");
  if (!isAbsolute(wrapperPath) || !isAbsolute(installedTokenPath)) {
    throw new Error("wrapper and installed token paths must be absolute");
  }
  const server = registry.mcpServers && registry.mcpServers[serverName];
  if (!isRecord(server)) throw new Error("MCP server is missing");
  const keys = Object.keys(server).sort((left, right) => Number(left > right) - Number(left < right));
  if (keys.some((key) => !["args", "command", "env"].includes(key))) {
    throw new Error("stdio server has unsupported fields");
  }
  if (server.command === "node" && Array.isArray(server.args) && server.args.length === 1
      && WRAPPER_FILE.test(String(server.args[0]))) {
    const envKeys = isRecord(server.env) ? Object.keys(server.env).sort((left, right) => Number(left > right) - Number(left < right)).join(",") : "";
    const canonical = envKeys === [...WRAPPER_ENV].sort((left, right) => Number(left > right) - Number(left < right)).join(",");
    const legacy = envKeys === [...LEGACY_WRAPPER_ENV].sort((left, right) => Number(left > right) - Number(left < right)).join(",");
    if (!isRecord(server.env) || (!canonical && !legacy)
        || server.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
      throw new Error("wrapper entry environment does not match the secret wrapper contract");
    }
    const output: Registry = JSON.parse(JSON.stringify(registry));
    output.mcpServers = { ...output.mcpServers, [serverName]: { ...server, args: [wrapperPath], env: {
      KHEREP_MCP_AUTH_FILE: server.env.KHEREP_MCP_AUTH_FILE,
      KHEREP_MCP_ENDPOINT: server.env.KHEREP_MCP_ENDPOINT,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    } } };
    return { registry: output };
  }
  if (server.command !== "npx" || !Array.isArray(server.args)) throw new Error("server is not an npx stdio bridge");
  if (!isRecord(server.env)
      || Object.getPrototypeOf(server.env) !== Object.prototype
      || Object.keys(server.env).length !== 1
      || server.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    throw new Error("stdio bridge environment is not the supported scoped TLS exception");
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
      command: "node",
      args: [wrapperPath],
      env: {
        KHEREP_MCP_AUTH_FILE: installedTokenPath,
        KHEREP_MCP_ENDPOINT: endpoint.toString(),
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
    },
  };
  return { registry: output, token: auth[1] };
}

function main(args: string[]): void {
  const [input, registryOutput, tokenOutput, serverName, wrapperPath, installedTokenPath] = args;
  if (!input || !registryOutput || !tokenOutput || !serverName || !wrapperPath || !installedTokenPath
      || path.resolve(input) === path.resolve(registryOutput)
      || path.resolve(registryOutput) === path.resolve(tokenOutput)) {
    throw new Error("usage: <input-registry> <fresh-registry-output> <fresh-token-output> <server-name> <wrapper-path> <installed-token-path>");
  }
  const migrated = migrateRegistry(readRegistry(input), serverName, wrapperPath, installedTokenPath);
  if (migrated.token === undefined) {
    writeFresh(registryOutput, migrated.registry);
    process.stdout.write(`MCP wrapper path updated: ${serverName} -> ${wrapperPath}\n`);
    return;
  }
  let tokenCreated = false;
  try {
    writeFreshText(tokenOutput, `${migrated.token}\n`);
    tokenCreated = true;
    writeFresh(registryOutput, migrated.registry);
  } catch (error) {
    if (tokenCreated) {
      try { fs.unlinkSync(tokenOutput); } catch {}
    }
    throw error;
  }
  process.stdout.write(`MCP auth isolated: ${serverName} -> secret wrapper\n`);
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
  catch (error) { process.stderr.write(`MCP wrapper migration failed: ${errorMessage(error)}\n`); process.exitCode = 1; }
}
