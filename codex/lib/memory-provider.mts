import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function nativeCommand(parts: readonly string[], platform: NodeJS.Platform = process.platform,
  extraCaCertificates?: string): string {
  const values = extraCaCertificates === undefined ? parts : [...parts, extraCaCertificates];
  if (values.some(value => typeof value !== "string" || /[\0\r\n]/.test(value)
      || (platform === "win32" && /["%!]/.test(value)))) throw new Error("Native hook command binding is invalid");
  const quote = (value: string) => platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = parts.map(quote).join(" ");
  if (extraCaCertificates === undefined) return command;
  return platform === "win32"
    ? `set "NODE_EXTRA_CA_CERTS=${extraCaCertificates}" && ${command}`
    : `NODE_EXTRA_CA_CERTS=${quote(extraCaCertificates)} ${command}`;
}

export type MemoryProvider = { provider: "unconfigured" };

// The server-based Central Brain MCP server, retired in OP-1429. An installer
// before the retirement persisted this selection and rendered its MCP table and
// native hooks into the managed config block. The binding is kept only so the
// upgrade can recognise that exact block as managed and replace it.
export interface CentralBrainBinding {
  mcpCli: string;
  profile: string;
  nativeHooks?: { contextCli: string; captureCli: string; extraCaCertificates?: string };
}

export interface MemorySelection {
  memoryProvider: MemoryProvider;
  // Present when the persisted selection named the retired provider. binding is
  // absent when that selection cannot be read back as the old installer wrote it.
  retired?: { provider: "central-brain"; binding?: CentralBrainBinding };
}

export function memoryProviderFile(codexHome = process.env.CODEX_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".codex")): string {
  return path.join(codexHome, "orchestra", "memory-provider.json");
}

function invalid(): never {
  throw new Error("Memory provider selection is invalid");
}

// Only selection and path references are read, never the referenced files.
function readSelection(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { provider: "unconfigured" };
    }
    return invalid();
  }
}

// The validation the pre-retirement installer applied. A selection it accepted
// is exactly one whose rendered block it wrote.
export function parseCentralBrainBinding(value: Record<string, unknown>): CentralBrainBinding {
  const keys = Object.keys(value).sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }).join(",");
  const { mcpCli, profile, nativeHooks } = value;
  const absolute = (entry: unknown): entry is string => typeof entry === "string"
    && path.isAbsolute(entry) && !/[\0\r\n]/.test(entry);
  if (!["mcpCli,profile,provider", "mcpCli,nativeHooks,profile,provider"].includes(keys)
      || ![mcpCli, profile].every(absolute)) return invalid();
  const binding: CentralBrainBinding = { mcpCli: String(mcpCli), profile: String(profile) };
  if (Object.hasOwn(value, "nativeHooks")) {
    const hooks = nativeHooks as Record<string, unknown> | null;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)
        || !["captureCli,contextCli", "captureCli,contextCli,extraCaCertificates"].includes(Object.keys(hooks).sort((left, right) => {
          if (left < right) return -1;
          if (left > right) return 1;
          return 0;
        }).join(","))) {
      return invalid();
    }
    const { contextCli, captureCli, extraCaCertificates } = hooks;
    const hasCa = Object.hasOwn(hooks, "extraCaCertificates");
    if (![contextCli, captureCli].every(absolute) || (hasCa && !absolute(extraCaCertificates))) return invalid();
    const ca = hasCa ? String(extraCaCertificates) : undefined;
    nativeCommand([String(contextCli), String(captureCli), String(profile)], process.platform, ca);
    binding.nativeHooks = { contextCli: String(contextCli), captureCli: String(captureCli),
      ...(hasCa ? { extraCaCertificates: ca } : {}) };
  }
  return binding;
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  return input as Record<string, unknown>;
}

function unconfigured(value: Record<string, unknown>): boolean {
  return value.provider === "unconfigured" && Object.keys(value).length === 1;
}

// An explicit selection chooses what is installed now, so naming the retired
// provider is an error. A persisted one only describes what an older installer
// did: it is reported as retired and the install proceeds unconfigured.
export function resolveMemoryProvider(file: string, explicit?: unknown): MemorySelection {
  if (explicit !== undefined) {
    const value = record(explicit);
    if (unconfigured(value)) return { memoryProvider: { provider: "unconfigured" } };
    if (value.provider === "central-brain") throw new Error("The Central Brain memory provider is retired");
    return invalid();
  }
  const value = record(readSelection(file));
  if (unconfigured(value)) return { memoryProvider: { provider: "unconfigured" } };
  if (value.provider !== "central-brain") return invalid();
  let binding: CentralBrainBinding | undefined;
  try { binding = parseCentralBrainBinding(value); } catch { binding = undefined; }
  return { memoryProvider: { provider: "unconfigured" },
    retired: binding ? { provider: "central-brain", binding } : { provider: "central-brain" } };
}

function notifyStrings(raw: string): { values: string[]; secondEnd: number } {
  const tokens = [...raw.matchAll(/"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'/g)];
  let cursor = 1;
  const values = tokens.map((token, index) => {
    if (raw.slice(cursor, token.index).trim() !== (index ? "," : "")) throw new Error("Unknown notify array");
    cursor = token.index! + token[0].length;
    return token[0].startsWith("'") ? token[0].slice(1, -1) : JSON.parse(token[0]) as string;
  });
  if (raw.slice(cursor, -1).trim()) throw new Error("Unknown notify array");
  return { values, secondEnd: tokens[1] ? tokens[1].index! + tokens[1][0].length : 0 };
}

function sameNotifyPath(actual: string, expected: string): boolean {
  const windows = (value: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(value);
  if (windows(actual) || windows(expected)) {
    return windows(actual) && windows(expected)
      && path.win32.normalize(actual).toLowerCase() === path.win32.normalize(expected).toLowerCase();
  }
  return path.normalize(actual) === path.normalize(expected);
}

// The Codex Computer Use notify wrapper: codex-computer-use.exe on Windows, the
// SkyComputerUseClient binary inside its app bundle on macOS (#55).
function isComputerUseWrapper(command: string): boolean {
  return path.win32.basename(command).toLowerCase() === "codex-computer-use.exe"
    || path.posix.basename(command) === "SkyComputerUseClient";
}

export function configureMemoryNotify(config: string, node: string, hook: string, previousNodes: string[] = []): string {
  const firstTable = config.search(/^\s*\[/m);
  const top = firstTable < 0 ? config : config.slice(0, firstTable);
  const line = top.match(/^\s*notify\s*=\s*(\[[^\r\n]*\])\s*(?:#.*)?$/m);
  if (line) {
    try {
      const { values, secondEnd } = notifyStrings(line[1]);
      const nodes = [node, ...previousNodes];
      if (values.length === 2 && nodes.includes(values[0]) && values[1] === hook) return config.replace(line[0], "");
      if (values.length === 4 && isComputerUseWrapper(values[0])
          && values[1] === "turn-ended" && values[2] === "--previous-notify") {
        const previous: unknown = JSON.parse(values[3]);
        if (Array.isArray(previous) && previous.length === 2 && previous.every((value) => typeof value === "string")
            && nodes.some((entry) => sameNotifyPath(previous[0], entry)) && sameNotifyPath(previous[1], hook)) {
          const wrapper = line[1].slice(0, secondEnd) + line[1].match(/[\t ]*\]$/)![0];
          return config.replace(line[0], line[0].replace(line[1], wrapper));
        }
      }
    } catch { /* Preserve custom or unsupported one-line TOML and nested JSON. */ }
    return config;
  }
  return config;
}
