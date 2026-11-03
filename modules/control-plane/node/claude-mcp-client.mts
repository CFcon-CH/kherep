import { MESSAGING_CLIENT_GRAPH as CLAUDE_CLIENT_GRAPH } from "./messaging-client-graph.mts";
export { CLAUDE_CLIENT_GRAPH };
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CLAUDE_TOOL_MATCHER = "^mcp__kherep_messaging__(sessions|send|inbox|reply|status)$";


const CLIENT_NAME = "kherep-claude-messaging-client";
const MANIFEST = "manifest.json";
const EXPECTED_DIRS = ["control-plane", "control-plane/node", "plugin", "plugin/.claude-plugin", "plugin/hooks"];
const GENERATED_FILES = ["mcp.json", "plugin/.claude-plugin/plugin.json", "plugin/hooks/hooks.json"];
const EXPECTED_FILES = [...CLAUDE_CLIENT_GRAPH.map((relative) => `control-plane/${relative}`), ...GENERATED_FILES].sort();
const COMMAND_UNSAFE = /[\u0000-\u001f\u007f$`%!'";&|<>(){}\[\]*?]/;

export interface ClaudeClientOptions { clientRoot: string; configRoot: string; nodeCommand: string }
export interface StageClaudeClientOptions extends ClaudeClientOptions { outputRoot: string; sourceRoot?: string }
export interface ClaudeClientRender {
  pluginJson: string; hooksJson: string; mcpJson: string; activationArgs: string[];
}
export interface ClaudeClientIdentity { manifestSha256: string; files: number }

interface ClientManifest {
  schemaVersion: 1; name: typeof CLIENT_NAME; clientRoot: string; configRoot: string; nodeCommand: string;
  graph: string[]; directories: string[]; files: Record<string, string>;
}

function absolute(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function trustedCommandPath(label: string, value: string): string {
  if (!absolute(value)) throw new Error(`${label} must be absolute`);
  if (COMMAND_UNSAFE.test(value)) throw new Error(`${label} is an unsafe command path`);
  return value;
}

function commandPath(root: string, ...parts: string[]): string {
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\")
    ? path.win32.join(root, ...parts) : path.posix.join(root, ...parts);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function relativeEntries(root: string): { directories: string[]; files: string[] } {
  const directories: string[] = [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`client content must not contain symlinks: ${relative}`);
      if (stat.isDirectory()) { directories.push(relative); visit(full); }
      else if (stat.isFile()) files.push(relative);
      else throw new Error(`client content has an unsupported entry: ${relative}`);
    }
  };
  visit(root);
  return { directories, files };
}

function assertExact(label: string, actual: string[], expected: string[]): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`unmanaged client content in ${label}`);
  }
}

export function renderClaudeClient(options: ClaudeClientOptions): ClaudeClientRender {
  const clientRoot = trustedCommandPath("client root", options.clientRoot);
  const configRoot = trustedCommandPath("config root", options.configRoot);
  const nodeCommand = trustedCommandPath("node command", options.nodeCommand);
  const hook = commandPath(clientRoot, "control-plane", "node", "mcp-intent-hook.mts");
  const bridge = commandPath(clientRoot, "control-plane", "node", "mcp-stdio-bridge.mts");
  const pluginJson = json({ name: CLIENT_NAME, version: "0.1.0",
    description: "Session-scoped Kherep messaging intent hook" });
  const hooksJson = json({ description: "Bind native Claude tool identity before Kherep messaging calls", hooks: {
    PreToolUse: [{ matcher: CLAUDE_TOOL_MATCHER, hooks: [{ type: "command", command: nodeCommand,
      args: [hook, "--config-root", configRoot, "--runtime", "claude-code"] }] }],
  } });
  const mcpJson = json({ mcpServers: { kherep_messaging: { command: nodeCommand,
    args: [bridge, "--config-root", configRoot] } } });
  return { pluginJson, hooksJson, mcpJson,
    activationArgs: ["--plugin-dir", commandPath(clientRoot, "plugin"), "--mcp-config", commandPath(clientRoot, "mcp.json"),
      "--strict-mcp-config"] };
}

function checkedSource(sourceRoot: string, relative: string): string {
  let current = sourceRoot;
  const rootStat = fs.lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("client source root must be a real directory");
  const parts = relative.split("/");
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`client source has a symlink ancestor: ${relative}`);
  }
  const source = path.join(current, parts.at(-1)!);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe or missing client source: ${relative}`);
  return source;
}

export function stageClaudeClient(options: StageClaudeClientOptions): ClaudeClientIdentity {
  if (!absolute(options.outputRoot)) throw new Error("output root must be absolute");
  if (fs.existsSync(options.outputRoot)) throw new Error("output root must not already exist");
  const sourceRoot = options.sourceRoot ?? path.resolve(import.meta.dirname, "..");
  const sources = CLAUDE_CLIENT_GRAPH.map((relative) => [relative, checkedSource(sourceRoot, relative)] as const);
  const rendered = renderClaudeClient(options);
  fs.mkdirSync(path.join(options.outputRoot, "plugin", ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(options.outputRoot, "plugin", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(options.outputRoot, "control-plane", "node"), { recursive: true });
  for (const [relative, source] of sources) {
    const target = path.join(options.outputRoot, "control-plane", relative);
    fs.copyFileSync(source, target);
  }
  fs.writeFileSync(path.join(options.outputRoot, "plugin", ".claude-plugin", "plugin.json"), rendered.pluginJson);
  fs.writeFileSync(path.join(options.outputRoot, "plugin", "hooks", "hooks.json"), rendered.hooksJson);
  fs.writeFileSync(path.join(options.outputRoot, "mcp.json"), rendered.mcpJson);
  const entries = relativeEntries(options.outputRoot);
  const files = Object.fromEntries(entries.files.map((relative) => [relative, sha256(path.join(options.outputRoot, relative))]));
  const manifest: ClientManifest = { schemaVersion: 1, name: CLIENT_NAME, clientRoot: options.clientRoot,
    configRoot: options.configRoot, nodeCommand: options.nodeCommand, graph: [...CLAUDE_CLIENT_GRAPH],
    directories: entries.directories, files };
  fs.writeFileSync(path.join(options.outputRoot, MANIFEST), json(manifest));
  return verifyClaudeClient(options.outputRoot);
}

function readManifest(root: string): ClientManifest {
  const file = path.join(root, MANIFEST);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("client manifest is not a regular file");
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ClientManifest>;
  if (value.schemaVersion !== 1 || value.name !== CLIENT_NAME || !Array.isArray(value.graph)
    || !Array.isArray(value.directories) || typeof value.files !== "object" || value.files === null
    || typeof value.clientRoot !== "string" || typeof value.configRoot !== "string" || typeof value.nodeCommand !== "string") {
    throw new Error("invalid client manifest");
  }
  assertExact("manifest graph", value.graph, [...CLAUDE_CLIENT_GRAPH]);
  renderClaudeClient({ clientRoot: value.clientRoot, configRoot: value.configRoot, nodeCommand: value.nodeCommand });
  return value as ClientManifest;
}

export function verifyClaudeClient(root: string, expectedClientRoot?: string): ClaudeClientIdentity {
  if (!absolute(root)) throw new Error("client root must be absolute");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("client root must be a real directory");
  const manifest = readManifest(root);
  if (expectedClientRoot !== undefined && manifest.clientRoot !== expectedClientRoot) {
    throw new Error("client root identity does not match the managed target");
  }
  const entries = relativeEntries(root);
  const files = entries.files.filter((relative) => relative !== MANIFEST);
  const unexpected = files.filter((relative) => !EXPECTED_FILES.includes(relative));
  if (unexpected.length > 0) throw new Error(`unmanaged client content: ${unexpected[0]}`);
  const missing = EXPECTED_FILES.filter((relative) => !files.includes(relative));
  if (missing.length > 0) throw new Error(`required client content missing: ${missing[0]}`);
  assertExact("directories", entries.directories, [...manifest.directories].sort());
  assertExact("files", files, Object.keys(manifest.files).sort());
  assertExact("declared directories", [...manifest.directories].sort(), [...EXPECTED_DIRS].sort());
  for (const relative of files) {
    if (!/^[a-f0-9]{64}$/.test(manifest.files[relative] ?? "")
      || sha256(path.join(root, relative)) !== manifest.files[relative]) throw new Error(`client drift: ${relative}`);
  }
  const rendered = renderClaudeClient(manifest);
  for (const [relative, expected] of [["plugin/.claude-plugin/plugin.json", rendered.pluginJson],
    ["plugin/hooks/hooks.json", rendered.hooksJson], ["mcp.json", rendered.mcpJson]] as const) {
    if (fs.readFileSync(path.join(root, relative), "utf8") !== expected) throw new Error(`manifest rendering mismatch: ${relative}`);
  }
  return { manifestSha256: sha256(path.join(root, MANIFEST)), files: files.length };
}

function usage(): string {
  return "Usage: claude-mcp-client.mts stage --output-root ABS --client-root ABS --config-root ABS --node ABS\n"
    + "       claude-mcp-client.mts verify --client-root ABS\n";
}

function values(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || result.has(key)) throw new Error("invalid arguments");
    result.set(key, value);
  }
  return result;
}

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === "--help") { process.stdout.write(usage()); return; }
  const command = argv[0]; const options = values(argv.slice(1));
  if (command === "stage" && options.size === 4) {
    const identity = stageClaudeClient({ outputRoot: options.get("--output-root")!, clientRoot: options.get("--client-root")!,
      configRoot: options.get("--config-root")!, nodeCommand: options.get("--node")! });
    process.stdout.write(`${JSON.stringify(identity)}\n`); return;
  }
  if (command === "verify" && (options.size === 1 || options.size === 2) && options.has("--client-root")
    && (options.size === 1 || options.has("--expected-client-root"))) {
    process.stdout.write(`${JSON.stringify(verifyClaudeClient(options.get("--client-root")!,
      options.get("--expected-client-root")))}\n`); return;
  }
  throw new Error("invalid arguments");
}

const entry = process.argv[1] ?? "";
let isMain = entry !== "" && import.meta.url === pathToFileURL(path.resolve(entry)).href;
try { isMain ||= entry !== "" && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; } catch { /* not main */ }
if (isMain) try { main(process.argv.slice(2)); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "client projection failed"}\n`); process.exitCode = 1;
}
