#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { outputPath, resolveInput } from "./lib/artifact.mts";
import { DEFAULT_CONFIG, type BackendSpec, type Env, type LocalInferenceConfig } from "./lib/config.mts";
import { type LoadedSchema, loadResponseFormat, matchesSchema } from "./lib/json-schema.mts";
import {
  assertLoopback, assertSshHost, configuredRoots, detectProfile, endpointUrl, portablePaths, resolveSpec, within,
} from "./lib/profile.mts";
import { ensureBackend, sshJson, type TransportDependencies, transportCall } from "./lib/transport.mts";

export { outputPath } from "./lib/artifact.mts";
export { DEFAULT_CONFIG } from "./lib/config.mts";
export { assertLoopback, assertSshHost, configuredRoots, detectProfile, endpointUrl, portablePaths, resolveSpec, within } from "./lib/profile.mts";
export { ensureBackend, sshJson, transportCall } from "./lib/transport.mts";

export const PRIVATE_PATH = /(?:^|[\\/])(?:credentials?|secrets?|host_vars|group_vars)(?:[\\/]|$)/i;
export const PRIVATE_TEXT = /customer[ -]?internals?|forge service cred|<private>/i;

function productEnv(env: Env, suffix: string): string | undefined {
  return env[`KHEREP_${suffix}`];
}

export interface RunnerArgs {
  inputFiles: string[];
  revealOutput?: boolean;
  private?: boolean;
  public?: boolean;
  task?: string;
  backend?: string;
  endpoint?: string;
  model?: string;
  mode?: string;
  output?: string;
  jsonSchema?: string;
  [key: string]: unknown;
}

export interface Runtime extends TransportDependencies {
  env?: Env;
  platform?: string;
  config?: LocalInferenceConfig;
}

export interface RunResult {
  status: "ok";
  id: string;
  host_profile: string;
  backend: string;
  transport: string;
  model: string;
  private: boolean;
  artifact: string;
  artifact_sha256: string;
  structured_output?: boolean;
  json_parsed?: boolean;
  schema_valid?: boolean;
  response?: string;
}

interface ChatCompletion { choices?: { message?: { content?: string; reasoning_content?: string } }[] }
interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  max_tokens: number;
  response_format?: LoadedSchema["responseFormat"];
  chat_template_kwargs?: { enable_thinking: boolean };
}

export function loadConfig(env: Env = process.env): LocalInferenceConfig {
  const file = productEnv(env, "LOCAL_CONFIG") ?? path.join(import.meta.dirname, "config.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as LocalInferenceConfig; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw new Error(`Cannot load local-inference config ${file}: ${(error as Error).message}`);
  }
}

export function parseArgs(argv: string[]): RunnerArgs {
  const out: RunnerArgs = { inputFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--reveal-output") out.revealOutput = true;
    else if (key === "--private") out.private = true;
    else if (key === "--public") out.public = true;
    else if (key === "--input-file") out.inputFiles.push(argv[++i]);
    else if (key.startsWith("--")) {
      const name = key.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      out[name] = argv[++i];
    } else throw new Error(`Unexpected argument: ${key}`);
  }
  return out;
}

function removeTemporaryArtifact(file: string): void {
  // Only an already-removed temporary file is harmless. Other cleanup errors
  // intentionally take precedence over a failed write or rename.
  try { fs.unlinkSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function run(argv: string[], runtime: Runtime = {}): Promise<RunResult> {
  const env = runtime.env || process.env;
  const profile = detectProfile(env, runtime.platform || process.platform);
  const args = parseArgs(argv);
  if (!args.task || args.task.length > 2_000) throw new Error("--task is required and limited to 2000 characters");
  const backend = args.backend;
  if (backend !== "win" && backend !== "mac") throw new Error("--backend must be win or mac");

  const locations = portablePaths(profile, env);
  const schemaInput = Object.hasOwn(args, "jsonSchema")
    ? loadResponseFormat(args.jsonSchema, locations.workspace)
    : null;
  const roots = configuredRoots(profile, env);
  const inputs = args.inputFiles.map((file) => resolveInput(file, roots));
  if (args.private && args.public) throw new Error("--private and --public are mutually exclusive");
  const inherentlyPrivate = PRIVATE_TEXT.test(args.task)
    || inputs.some((item) => PRIVATE_PATH.test(item.path) || within(item.path, locations.credentials))
    || (schemaInput !== null && (PRIVATE_PATH.test(schemaInput.sourcePath)
      || within(schemaInput.sourcePath, locations.credentials)));
  if (args.public && inherentlyPrivate) {
    throw new Error("--public conflicts with privacy-marked input; classify the run as private");
  }
  // File input is fail-closed: a caller must explicitly attest --public before
  // model output derived from an ordinary workspace file can return to Claude.
  const hasFileInput = inputs.length > 0 || Boolean(schemaInput);
  const privateRun = Boolean(args.private || inherentlyPrivate || (hasFileInput && !args.public));
  if (privateRun && !hasFileInput) throw new Error("Private work requires a file input; never put private content inline");

  const config = runtime.config || loadConfig(env);
  let spec: BackendSpec = resolveSpec(config, profile, backend, env);
  if (args.endpoint) {
    if (productEnv(env, "LOCAL_ALLOW_ENDPOINT_OVERRIDE") !== "1") throw new Error("Endpoint override is disabled");
    assertLoopback(args.endpoint);
    spec = { ...spec, transport: "local", endpoint: args.endpoint };
  }
  const { call, models, close } = await ensureBackend(spec, locations.home, runtime);
  let model: string | undefined;
  let response: string | undefined;
  let parsedResponse: unknown;
  let jsonParsed = false;
  let schemaValid = false;
  try {
    const configuredModel = spec.model && spec.model !== "discover" ? spec.model : null;
    model = args.model || configuredModel || models.data?.[0]?.id;
    if (!model) {
      const detail = spec.engine === "LM Studio" ? "; inspect `~/.lmstudio/bin/lms ls` and load an installed model" : "";
      throw new Error(`Local endpoint reported no loaded model${detail}`);
    }

    const fileText = inputs.map((item, index) => `\n--- LOCAL INPUT ${index + 1}: ${path.basename(item.path)} ---\n${item.content}`).join("");
    const system = privateRun
      ? "You run locally. Analyze only the supplied files. Never reproduce credential/token values; redact secrets in findings. Return concise evidence with file references."
      : "You are a concise local research worker. Return evidence-backed findings.";
    const body: ChatRequest = {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: `${args.task}${fileText}` }],
      temperature: 0.2,
      max_tokens: args.mode === "reasoning" ? 8192 : 700,
    };
    if (schemaInput) body.response_format = schemaInput.responseFormat;
    if (backend === "win" && args.mode !== "reasoning") body.chat_template_kwargs = { enable_thinking: false };

    const completion = await call<ChatCompletion>("/chat/completions", "POST", body, args.mode === "reasoning" ? 300_000 : 120_000);
    const message = completion.choices?.[0]?.message;
    response = message && (message.content || message.reasoning_content);
    if (!response) throw new Error("Local model returned no usable content");
    if (schemaInput) {
      try {
        parsedResponse = JSON.parse(response);
        jsonParsed = true;
      } catch {}
      if (jsonParsed) schemaValid = matchesSchema(parsedResponse, schemaInput.responseFormat.json_schema.schema);
    }
  } finally {
    close();
  }

  const id = crypto.randomUUID();
  const target = outputPath(args.output, id, locations.output);
  const artifact = {
    schema: "kherep.local-inference.v1", id, created_at: new Date().toISOString(), host_profile: profile,
    backend,
    endpoint: spec.transport === "ssh" ? `ssh://${spec.sshHost}/${spec.endpoint}` : spec.endpoint,
    transport: spec.transport, model, private: privateRun, task: args.task,
    inputs: inputs.map((item) => ({ path: item.path, size: item.size, sha256: crypto.createHash("sha256").update(item.bytes).digest("hex") })),
    response,
  };
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const artifactBytes = JSON.stringify(artifact, null, 2) + "\n";
  let tempCreated = false;
  try {
    fs.writeFileSync(temp, artifactBytes, { mode: 0o600, flag: "wx" });
    tempCreated = true;
    fs.renameSync(temp, target);
  } finally {
    if (tempCreated) {
      removeTemporaryArtifact(temp);
    }
  }
  const digest = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  return {
    status: "ok", id, host_profile: profile, backend, transport: spec.transport,
    model, private: privateRun, artifact: target, artifact_sha256: digest,
    ...(schemaInput ? { structured_output: true, json_parsed: jsonParsed, schema_valid: schemaValid } : {}),
    ...(args.revealOutput && !privateRun ? { response } : {}),
  };
}

async function main(): Promise<void> {
  try { process.stdout.write(JSON.stringify(await run(process.argv.slice(2))) + "\n"); }
  catch (error) { process.stderr.write(`local-inference failed: ${(error as Error).message}\n`); process.exitCode = 1; }
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

if (isMainModule()) await main();
