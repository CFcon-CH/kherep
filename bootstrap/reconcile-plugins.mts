#!/usr/bin/env node
// Idempotent, fail-closed Claude marketplace/plugin reconciliation. Child
// processes always use argv form; captured list/MCP data is never logged.

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { productEnv } from "../lib/product-env.mts";
import { findWindowsClaude } from "./claude-binary.mts";
import {
  ReconcileError,
  assertNoMarketplaceCollision,
  marketplaceMatches,
  parseMarketplaceList,
  parseMarketplaceManifest,
  parsePluginList,
  parsePluginManifest,
  pluginInstalled,
  pluginSatisfied,
  safeString,
  verifyFinalState,
  type ClaudeState,
  type MarketplaceExpectation,
  type PluginEntry,
} from "./plugin-contract.mts";
import { parseVersionManifest, raisePlugins, type RaiseRequest } from "./plugin-raise.mts";
import { warnUnmanagedScopes } from "./plugin-scopes.mts";
import { errorStatus, isArgvList, isRecord } from "./shape.mts";

const MAX_OUTPUT = 16 * 1024 * 1024;

interface ClaudeCommand {
  executable: string;
  prefixArgs: string[];
}

interface ClaudeFailure {
  failed: true;
  status: number;
}

function fail(message: string): never {
  throw new ReconcileError(message);
}

function readManifest(file: string, label: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    fail(`cannot read ${label} manifest`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`malformed ${label} manifest JSON`);
  }
}

interface LookupDeps {
  platform?: NodeJS.Platform;
  isFile?: (file: string) => boolean;
}

// On Windows a bare "claude" would reach only the npm .cmd shim, which cannot
// run without a shell (issue #99), so the native executable is resolved here.
function defaultClaude(env: NodeJS.ProcessEnv, deps: LookupDeps): string {
  if ((deps.platform ?? process.platform) !== "win32") return "claude";
  return findWindowsClaude(env.PATH ?? env.Path ?? "", deps.isFile)
    ?? fail("claude not found on PATH as claude.exe or as an npm shim with its native claude.exe; "
      + "set KHEREP_CLAUDE_BIN to the claude executable");
}

export function getClaudeCommand(env: NodeJS.ProcessEnv = process.env, deps: LookupDeps = {}): ClaudeCommand {
  const executable = productEnv(env, "CLAUDE_BIN") ?? defaultClaude(env, deps);
  if (!safeString(executable)) fail("invalid Claude executable configuration");
  let prefixArgs: unknown = [];
  const rawArgs = productEnv(env, "CLAUDE_BIN_ARGS_JSON");
  if (rawArgs !== undefined) {
    try {
      prefixArgs = JSON.parse(rawArgs);
    } catch {
      fail("invalid Claude executable argument configuration");
    }
  }
  if (!isArgvList(prefixArgs)) fail("invalid Claude executable argument configuration");
  return { executable, prefixArgs };
}

// A nonzero exit is reported as a value, never thrown: the caller decides from
// the re-read state whether the mutation converged anyway.
function execClaude(command: ClaudeCommand, args: string[], captureStdout: boolean): string | ClaudeFailure {
  try {
    return childProcess.execFileSync(command.executable, [...command.prefixArgs, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
      shell: false,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return { failed: true, status: errorStatus(error) ?? 1 };
  }
}

function isFailure(result: unknown): result is ClaudeFailure {
  return isRecord(result) && result.failed === true;
}

function runClaudeJson(command: ClaudeCommand, args: string[], label: string): unknown {
  const result = execClaude(command, args, true);
  if (isFailure(result)) fail(`Claude ${label} failed`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    fail(`Claude ${label} returned malformed JSON`);
  }
  return parsed;
}

function readState(command: ClaudeCommand): ClaudeState {
  const marketplaces = parseMarketplaceList(
    runClaudeJson(command, ["plugin", "marketplace", "list", "--json"], "marketplace list"),
  );
  const unmanaged: PluginEntry[] = [];
  const plugins = parsePluginList(
    runClaudeJson(command, ["plugin", "list", "--json"], "plugin list"),
    (entry) => unmanaged.push(entry),
  );
  warnUnmanagedScopes(unmanaged);
  return { marketplaces, plugins };
}

function runMutation(command: ClaudeCommand, args: string[]): { ok: boolean } {
  return { ok: !isFailure(execClaude(command, args, false)) };
}

function reconcileMarketplace(command: ClaudeCommand, state: ClaudeState, expected: MarketplaceExpectation): ClaudeState {
  assertNoMarketplaceCollision(state, expected);
  if (marketplaceMatches(state.marketplaces.get(expected.name), expected)) return state;
  process.stdout.write(`reconcile-plugins: add marketplace ${expected.name}\n`);
  const result = runMutation(command, [
    "plugin", "marketplace", "add", "--scope", "user", expected.ref,
  ]);
  const refreshed = readState(command);
  assertNoMarketplaceCollision(refreshed, expected);
  if (!marketplaceMatches(refreshed.marketplaces.get(expected.name), expected)) {
    fail(result.ok
      ? `marketplace add returned success without required state: ${expected.name}`
      : `marketplace add failed without required state: ${expected.name}`);
  }
  if (!result.ok) {
    process.stdout.write(`reconcile-plugins: marketplace converged after nonzero response: ${expected.name}\n`);
  }
  return refreshed;
}

function reconcilePlugin(command: ClaudeCommand, state: ClaudeState, id: string): ClaudeState {
  if (pluginSatisfied(state, id)) return state;
  let current = state;
  if (!pluginInstalled(current, id)) {
    process.stdout.write(`reconcile-plugins: install plugin ${id}\n`);
    const result = runMutation(command, ["plugin", "install", "--scope", "user", id]);
    current = readState(command);
    if (!result.ok) {
      if (!pluginSatisfied(current, id)) fail(`plugin install failed without required state: ${id}`);
      process.stdout.write(`reconcile-plugins: plugin converged after nonzero response: ${id}\n`);
      return current;
    }
    if (!pluginInstalled(current, id)) {
      fail(`plugin install returned success without installed state: ${id}`);
    }
  }
  if (!pluginSatisfied(current, id)) {
    process.stdout.write(`reconcile-plugins: enable plugin ${id}\n`);
    const result = runMutation(command, ["plugin", "enable", "--scope", "user", id]);
    current = readState(command);
    if (!pluginSatisfied(current, id)) {
      fail(result.ok
        ? `plugin enable returned success without required state: ${id}`
        : `plugin enable failed without required state: ${id}`);
    }
    if (!result.ok) {
      process.stdout.write(`reconcile-plugins: plugin converged after nonzero response: ${id}\n`);
    }
  }
  return current;
}

// Without `raise`, installed plugins keep their versions.
export function reconcile(
  marketplaceManifestPath: string, pluginManifestPath: string, raise?: RaiseRequest, env: NodeJS.ProcessEnv = process.env,
): void {
  const marketplaces = parseMarketplaceManifest(readManifest(marketplaceManifestPath, "marketplaces"));
  const names = new Set(marketplaces.map((item) => item.name));
  const requiredPlugins = parsePluginManifest(readManifest(pluginManifestPath, "plugins"), names);
  const reviewed = raise ? parseVersionManifest(readManifest(raise.versionManifestPath, "plugin versions")) : new Map<string, string>();
  const command = getClaudeCommand(env);

  let state = readState(command); // Complete list-json preflight before any mutator.
  for (const expected of marketplaces) assertNoMarketplaceCollision(state, expected);
  for (const expected of marketplaces) state = reconcileMarketplace(command, state, expected);
  for (const id of requiredPlugins) state = reconcilePlugin(command, state, id);

  const notRaised = raisePlugins(state, reviewed, raise?.claudeHome ?? "", {
    mutate: (args) => runMutation(command, args).ok,
    readState: () => readState(command),
  });

  state = readState(command); // Independent final capability snapshot.
  verifyFinalState(state, marketplaces, requiredPlugins);
  if (notRaised.length > 0) fail(`plugin not raised: ${notRaised.join(", ")}`);
  process.stdout.write("reconcile-plugins: required marketplaces and plugins verified\n");
}

function cli(): void {
  const [marketplaces, plugins, versionManifestPath, claudeHome, ...rest] = process.argv.slice(2);
  if (!plugins || Boolean(versionManifestPath) !== Boolean(claudeHome) || rest.length > 0) {
    fail("usage: reconcile-plugins.mts <marketplaces.json> <plugins.json> [<plugin-versions.json> <claude-home>]");
  }
  reconcile(marketplaces, plugins, versionManifestPath ? { versionManifestPath, claudeHome } : undefined);
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
  try {
    cli();
  } catch (error) {
    const message = error instanceof ReconcileError ? error.message : "unexpected internal error";
    process.stderr.write(`reconcile-plugins: FATAL: ${message}\n`);
    process.exitCode = 1;
  }
}
