import { createHash } from "node:crypto";
import type { AgentInventory } from "./model-agent-inventory.mts";
import { EFFORTS, ROLES, record, type ModelRole } from "./model-policy.mts";

export interface ModelChoice { model?: string; effort?: string }
export interface ModelMetadata { dispatchable?: boolean; efforts?: string[] }
export interface UserModelPolicy {
  schemaVersion: 1; present: boolean; byteSha256: string | null; semanticSha256: string;
  roles: ReadonlyMap<ModelRole, ModelChoice>; agents: ReadonlyMap<string, ModelChoice>; models: ReadonlyMap<string, ModelMetadata>;
}
export class UserModelPolicyError extends Error {
  readonly code: string; readonly keyPath: string;
  constructor(code: string, keyPath: string) {
    super(`model-policy-user: ${keyPath}: ${code}`);
    this.name = "UserModelPolicyError"; this.code = code; this.keyPath = keyPath;
  }
}
function fail(code: string, path: string): never { throw new UserModelPolicyError(code, path); }
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);
const modelName = (value: unknown): value is string => typeof value === "string" && value.length <= 200
  && value !== "inherit" && /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/.test(value) && !RESERVED.has(value);
const effort = (value: unknown): value is string => typeof value === "string" && EFFORTS.includes(value);
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const compare = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number => a < b ? -1 : a > b ? 1 : 0;

// JSON.parse establishes grammar first. Walk the original bytes as well: its
// reconstructed object alone cannot reveal duplicate (including escaped) keys.
type JsonValueVisitor = (keyPath: readonly string[], start: number, end: number) => void;
function validateJsonStructure(text: string, maxDepth: number, visitor?: JsonValueVisitor): void {
  let cursor = 0;
  const keyPath: string[] = [];
  const space = (): void => { while (cursor < text.length && /[ \t\r\n]/.test(text[cursor]!)) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (text[cursor] !== '"') cursor += text[cursor] === "\\" ? 2 : 1;
    return JSON.parse(text.slice(start, ++cursor)) as string;
  };
  const readValue = (depth: number): void => {
    if (depth > maxDepth) fail("depth", "json");
    const kind = text[cursor];
    if (kind === "{" || kind === "[") {
      const end = kind === "{" ? "}" : "]", keys = new Set<string>();
      cursor++; space();
      if (text[cursor] === end) { cursor++; return; }
      for (let index = 0; ; index++) {
        let key = String(index);
        if (kind === "{") {
          key = string();
          if (keys.has(key)) fail("duplicate-key", "json");
          keys.add(key); space(); cursor++; // grammar already proves the colon
        }
        if (visitor) keyPath.push(key);
        visit(depth + 1);
        if (visitor) keyPath.pop();
        space();
        if (text[cursor++] === end) return;
        space(); // grammar already proves the comma
      }
    }
    if (kind === '"') { string(); return; }
    while (cursor < text.length && !/[ \t\r\n,}\]]/.test(text[cursor]!)) cursor++;
  };
  const visit = (depth: number): void => {
    space();
    const start = cursor;
    readValue(depth);
    visitor?.(keyPath, start, cursor);
  };
  visit(0);
}

// Shared strict JSON seam for the bounded user file and larger receipt document.
// Both consumers retain duplicate-key evidence before reconstructing objects.
const DEFAULT_JSON_LIMITS: Readonly<{ maxBytes: number; maxDepth: number }> = Object.freeze({ maxBytes: 65_536, maxDepth: 16 });
export function parseModelPolicyJson(text: string, limits = DEFAULT_JSON_LIMITS, visitor?: JsonValueVisitor): unknown {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 1_048_576
    || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 32) fail("invalid-json-limits", "json");
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > limits.maxBytes) fail("input-size", "json");
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("invalid-json", "json"); }
  validateJsonStructure(text, limits.maxDepth, visitor);
  return value;
}

function object(value: unknown, path: string, fields?: readonly string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length > 512) fail("invalid-object", path);
  for (const key of Object.keys(value)) {
    if (RESERVED.has(key)) fail("reserved-key", path);
    if (fields && !fields.includes(key)) fail("unknown-field", `${path}.unknown`);
  }
  return value;
}
function choice(value: unknown, path: string): ModelChoice {
  const row = object(value, path, ["model", "effort"]);
  const result: ModelChoice = {};
  if (Object.hasOwn(row, "model")) {
    if (!modelName(row.model)) fail("invalid-model", `${path}.model`);
    result.model = row.model;
  }
  if (Object.hasOwn(row, "effort")) {
    if (!effort(row.effort)) fail("invalid-effort", `${path}.effort`);
    result.effort = row.effort;
  }
  return result;
}

// Pure shared-shape parser. Runtime model support is validated by the resolver,
// not invented by this metadata layer. Diagnostics never echo unknown input keys.
export function parseUserModelPolicy(text: string | undefined, inventory: AgentInventory): UserModelPolicy {
  if (text !== undefined && (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 65_536)) fail("input-size", "json");
  const value = text === undefined ? {} : parseModelPolicyJson(text);
  const top = object(value, "json", ["schema_version", "roles", "agents", "models"]);
  if (Object.hasOwn(top, "schema_version") && top.schema_version !== 1) fail("unsupported-version", "schema_version");
  const roles = new Map<ModelRole, ModelChoice>(), agents = new Map<string, ModelChoice>(), models = new Map<string, ModelMetadata>();
  if (Object.hasOwn(top, "roles")) for (const [id, raw] of Object.entries(object(top.roles, "roles"))) {
    if (!ROLES.includes(id as ModelRole)) fail("unknown-role", "roles.$key");
    roles.set(id as ModelRole, choice(raw, `roles.${id}`));
  }
  if (Object.hasOwn(top, "agents")) for (const [id, raw] of Object.entries(object(top.agents, "agents"))) {
    const matches = inventory.bySourceId.get(id);
    if (!matches?.length) fail("unknown-source-agent", "agents.$key");
    if (matches.length !== 1) fail("ambiguous-source-agent-id", "agents.$key");
    agents.set(id, choice(raw, `agents.${id}`));
  }
  if (Object.hasOwn(top, "models")) for (const [id, raw] of Object.entries(object(top.models, "models"))) {
    if (!modelName(id)) fail("invalid-model", "models.$key");
    const row = object(raw, "models.$key", ["dispatchable", "efforts"]), metadata: ModelMetadata = {};
    if (Object.hasOwn(row, "dispatchable")) {
      if (typeof row.dispatchable !== "boolean") fail("invalid-dispatchable", "models.$key.dispatchable");
      metadata.dispatchable = row.dispatchable;
    }
    if (Object.hasOwn(row, "efforts")) {
      if (!Array.isArray(row.efforts) || row.efforts.length > EFFORTS.length || !row.efforts.every(effort)
        || new Set(row.efforts).size !== row.efforts.length) fail("invalid-efforts", "models.$key.efforts");
      metadata.efforts = [...row.efforts];
    }
    models.set(id, metadata);
  }
  const semantics = { roles: [...roles].sort(compare), agents: [...agents].sort(compare),
    models: [...models].sort(compare).map(([id, row]) => [id, { ...row, ...(row.efforts ? { efforts: [...row.efforts].sort((a, b) => a < b ? -1 : a > b ? 1 : 0) } : {}) }]) };
  return { schemaVersion: 1, present: text !== undefined, byteSha256: text === undefined ? null : sha(text),
    semanticSha256: sha(JSON.stringify(semantics)), roles, agents, models };
}
