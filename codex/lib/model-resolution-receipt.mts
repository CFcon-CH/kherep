import { createHash } from "node:crypto";
import { buildAgentInventory, verifyAgentInventory, type AgentInventory, type AgentIdentity } from "./model-agent-inventory.mts";
import { buildCatalogSupport, parseModelPolicy, resolveModels, resolveEffectiveSelections, validateSupportedPair, ROLES, EFFORTS, record, type CatalogSupport,
  type DefaultRealization, type ModelEffort, type ModelRole, type EffectiveSelection, type EffectiveResolutionV2, type ResolutionInputs, type RetainedSelections } from "./model-policy.mts";
import { parseModelPolicyJson, parseUserModelPolicy, UserModelPolicyError, type ModelChoice, type UserModelPolicy } from "./model-policy-user.mts";

export interface SelectionIdentityContext {
  sourceRevision: string; previousSelectionId: string | null; supportSource: "fresh-catalog" | "verified-snapshot";
}
export interface RenderedModelOutput {
  target: string; kind: "agent-toml" | "dispatch-snapshot"; sourceBinding: string; content: string;
}
export interface ModelOutputIdentity {
  target: string; kind: RenderedModelOutput["kind"]; sourceBinding: string; sha256: string; selectionId: string;
}
// Relative to CODEX_HOME: install.mts writes ../parity/capabilities.json from
// hooks/kherep-maestro. This adapter-owned target is never receipt-controlled.
export const MODEL_DISPATCH_SNAPSHOT_TARGET = "hooks/parity/capabilities.json";
function fail(code: string): never { throw new Error(`model-receipt: ${code}`); }
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function keys(value: unknown, allowed: readonly string[], required = allowed): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail("unknown-identity-field");
}
function canonical(value: unknown, stack = new Set<object>(), depth = 0): string {
  if (depth > 32) fail("identity-depth");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || stack.has(value)) fail("invalid-canonical-value");
  stack.add(value);
  let result: string;
  if (Array.isArray(value)) result = `[${value.map(item => canonical(item, stack, depth + 1)).join(",")}]`;
  else {
    if (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype) fail("invalid-canonical-object");
    result = `{${Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], stack, depth + 1)}`).join(",")}}`;
  }
  stack.delete(value);
  return result;
}

// Identity calculation is separate from receipt validation and output hashing.
// No timestamp or output bytes enter this payload, avoiding snapshot hash cycles.
export function modelSelectionId(resolution: EffectiveResolutionV2, context: SelectionIdentityContext): string {
  keys(context, ["sourceRevision", "previousSelectionId", "supportSource"]);
  if (typeof context.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(context.sourceRevision)
    || context.previousSelectionId !== null && !isDigest(context.previousSelectionId)
    || !["fresh-catalog", "verified-snapshot"].includes(context.supportSource)) fail("invalid-selection-context");
  keys(resolution, ["schemaVersion", "policySha256", "inventoryDigest", "catalogDigest", "userIdentity", "agentDefaultsDigest", "roles", "agents", "supportedModels"]);
  if (resolution.schemaVersion !== 2 || !isDigest(resolution.policySha256) || !isDigest(resolution.inventoryDigest)
    || !isDigest(resolution.catalogDigest) || !isDigest(resolution.agentDefaultsDigest)) fail("invalid-selection-identity");
  return sha(canonical({ context, resolution }));
}

// Only caller-rendered bytes are hashed. This never reconstructs historic outputs
// with the current renderer and performs no file writes or native reads.
export function createModelOutputManifest(outputs: readonly RenderedModelOutput[], selectionId: string, inventory: AgentInventory): ModelOutputIdentity[] {
  if (!isDigest(selectionId) || !Array.isArray(outputs) || outputs.length > 513) fail("invalid-output-generation");
  const targets = new Set<string>(), bindings = new Set<string>();
  let snapshots = 0;
  const result = outputs.map((raw): ModelOutputIdentity => {
    keys(raw, ["target", "kind", "sourceBinding", "content"]);
    const output = raw as unknown as RenderedModelOutput;
    if (typeof output.target !== "string" || output.target.length > 512 || output.target.split("/").some(part =>
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === "." || part === "..")) fail("invalid-output-target");
    if (targets.has(output.target.toLowerCase())) fail("duplicate-output-target");
    targets.add(output.target.toLowerCase());
    if (output.kind === "agent-toml") {
      const agent = inventory.agents.find(agent => agent.bindingId === output.sourceBinding);
      if (!agent || output.target !== `agents/${agent.installedName}.toml` || bindings.has(agent.bindingId)) fail("output-binding-conflict");
      bindings.add(agent.bindingId);
    } else if (output.kind === "dispatch-snapshot" && output.sourceBinding === "dispatch"
      && output.target === MODEL_DISPATCH_SNAPSHOT_TARGET) snapshots++;
    else fail("output-binding-conflict");
    if (typeof output.content !== "string" || Buffer.byteLength(output.content, "utf8") > 1_048_576) fail("invalid-output-bytes");
    return { target: output.target, kind: output.kind, sourceBinding: output.sourceBinding, sha256: sha(output.content), selectionId };
  });
  if (snapshots !== 1 || bindings.size !== inventory.agents.length) fail("incomplete-output-generation");
  return result.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
}

export function verifyModelOutputManifest(expected: readonly ModelOutputIdentity[], actual: readonly RenderedModelOutput[], selectionId: string, inventory: AgentInventory): void {
  const sorted = validateOutputIdentities(expected, selectionId, inventory);
  const observed = createModelOutputManifest(actual, selectionId, inventory);
  if (canonical(sorted) !== canonical(observed)) fail("output-conflict");
}
function validateOutputIdentities(expected: readonly ModelOutputIdentity[], selectionId: string, inventory: AgentInventory): ModelOutputIdentity[] {
  if (!Array.isArray(expected) || expected.length > 513) fail("invalid-output-manifest");
  const targets = new Set<string>();
  for (const raw of expected) {
    keys(raw, ["target", "kind", "sourceBinding", "sha256", "selectionId"]);
    const row = raw as unknown as ModelOutputIdentity;
    if (typeof row.target !== "string" || typeof row.sourceBinding !== "string" || !["agent-toml", "dispatch-snapshot"].includes(row.kind)
      || !isDigest(row.sha256) || row.selectionId !== selectionId || targets.has(row.target.toLowerCase())) fail("output-conflict");
    targets.add(row.target.toLowerCase());
  }
  // Validate completeness, exact bindings/targets and portable uniqueness without
  // manufacturing historical content or requiring obsolete generated bytes.
  createModelOutputManifest(expected.map(row => ({ target: row.target, kind: row.kind, sourceBinding: row.sourceBinding, content: "" })), selectionId, inventory);
  return [...expected].sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
}

export interface ReceiptEvidence {
  context: SelectionIdentityContext; policyText: string; inventory: AgentInventory; catalog: CatalogSupport;
  user: UserModelPolicy; agentDefaults?: ReadonlyMap<string, ModelChoice>; retained?: RetainedSelections; refresh?: boolean;
  capturedAt: string | null; runtimeVersion: string | null; collectorVersion: string | null;
  predecessor?: VerifiedInstalledModelState;
}
export type ModelMigrationRecord = { kind: "fresh"; status: "not-required" } | {
  kind: "predecessor"; status: "verified-conflict-free"; sourceVersion: 1 | 2; sourceRevision: string;
  selectionId: string; oldPolicySha256: string; oldCatalogSha256: string; catalogSupportDigest: string;
  inventoryDigest: string; originEvidenceSha256: string; evidenceSha256: string;
  outputs: readonly ModelOutputIdentity[];
  overlays: readonly { overlayId: string; evidenceSha256: string }[];
  retainedValues: { roles: Record<string, EffectiveSelection>; agents: readonly (AgentIdentity & EffectiveSelection)[] };
};
interface UserSnapshot {
  roles: Record<string, ModelChoice>; agents: Record<string, ModelChoice>;
  models: Record<string, { dispatchable?: boolean; efforts?: string[] }>;
}
export interface ModelResolutionReceiptV2 {
  schemaVersion: 2; persistenceVersion: 1; selectionId: string;
  inputs: SelectionIdentityContext & { policySha256: string; inventoryDigest: string; catalogDigest: string;
    agentDefaultsDigest: string; user: { snapshot: UserSnapshot; identity: EffectiveResolutionV2["userIdentity"] }; refresh: boolean };
  catalog: { snapshot: CatalogSupport["catalog"]; digest: string; capturedAt: string | null; captureStatus: "KNOWN" | "UNKNOWN";
    runtimeVersion: { value: string | null; status: "KNOWN" | "UNKNOWN" };
    collectorVersion: { value: string | null; status: "KNOWN" | "UNKNOWN" } };
  inventory: { digest: string; agents: AgentInventory["agents"] };
  resolution: EffectiveResolutionV2; outputs: ModelOutputIdentity[];
  migration: ModelMigrationRecord;
}
const VERIFIED = Symbol("verified-model-state");
// Only exact identities created by successful verification may attest a
// predecessor. The symbol remains a type marker, never an authority token.
const verifiedStates = new WeakMap<object, string>();
export interface VerifiedInstalledModelState {
  readonly [VERIFIED]: true; sourceVersion: 1 | 2; selectionId: string; evidenceDigest: string;
  resolution: EffectiveResolutionV2; retained: RetainedSelections; user: UserModelPolicy; catalog: CatalogSupport; inventoryDigest: string;
  inventory: AgentInventory; outputs: readonly ModelOutputIdentity[]; sourceRevision: string; receipt?: ModelResolutionReceiptV2;
  recognizedOverlays: readonly ObserverModelOverlay[];
  originEvidenceDigest: string; recordedCatalogSha256: string; recognizedOverlayPins: readonly string[];
}
export function assertVerifiedModelState(value: VerifiedInstalledModelState): void {
  const expected = value && verifiedStates.get(value);
  if (!expected) fail("unverified-installed-state");
  try { if (stateFingerprint(value) !== expected) fail("unverified-installed-state"); }
  catch { fail("unverified-installed-state"); }
}
function stateFingerprint(value: unknown): string {
  const visiting = new Set<object>();
  const snapshot = (item: unknown, depth = 0): unknown => {
    if (depth > 64) fail("unverified-installed-state");
    if (item === null) return ["null"];
    if (typeof item !== "object") return item === undefined ? ["undefined"] : [typeof item, item];
    if (visiting.has(item)) fail("unverified-installed-state");
    visiting.add(item);
    const result = item instanceof Map ? ["map", [...item].map(([key, entry]) => [snapshot(key, depth + 1), snapshot(entry, depth + 1)])]
      : Array.isArray(item) ? ["array", item.map(entry => snapshot(entry, depth + 1))]
      : ["object", Object.keys(item).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(key => [key, snapshot((item as Record<string, unknown>)[key], depth + 1)])];
    visiting.delete(item);
    return result;
  };
  return sha(canonical(snapshot(value)));
}
function registerVerifiedState(value: VerifiedInstalledModelState): VerifiedInstalledModelState {
  // Detach every caller-owned object/array/Map before freezing. Map entries are
  // frozen recursively, and the private fingerprint also detects set/delete/
  // clear, which Object.freeze(Map) cannot prevent.
  const captured = { ...structuredClone(value), [VERIFIED]: true as const };
  const seen = new Set<object>();
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (item instanceof Map) for (const [key, entry] of item) { freeze(key); freeze(entry); }
    else for (const entry of Object.values(item)) freeze(entry);
    Object.freeze(item);
  };
  freeze(captured);
  verifiedStates.set(captured, stateFingerprint(captured));
  return captured;
}
export const modelEvidenceDigest = (value: unknown): string => sha(canonical(value));
function parseReceiptJson(text: string): unknown {
  try { return parseModelPolicyJson(text, { maxBytes: 1_048_576, maxDepth: 32 }); }
  catch (error) { fail(error instanceof UserModelPolicyError ? `receipt-json-${error.code}` : "receipt-json-invalid"); }
}
function userSnapshot(user: UserModelPolicy): UserSnapshot {
  return { roles: Object.fromEntries(user.roles), agents: Object.fromEntries(user.agents), models: Object.fromEntries(user.models) };
}
function restoreUser(snapshot: unknown, identity: EffectiveResolutionV2["userIdentity"], inventory: AgentInventory): UserModelPolicy {
  keys(identity, ["present", "byteSha256", "semanticSha256"]);
  if (typeof identity.present !== "boolean" || !isDigest(identity.semanticSha256)
    || (identity.present ? !isDigest(identity.byteSha256) : identity.byteSha256 !== null)) fail("invalid-user-identity");
  let parsed: UserModelPolicy;
  try { parsed = parseUserModelPolicy(canonical(snapshot), inventory); } catch { fail("invalid-user-snapshot"); }
  if (parsed.semanticSha256 !== identity.semanticSha256 || !identity.present && (parsed.roles.size || parsed.agents.size || parsed.models.size)) fail("user-identity-conflict");
  return { ...parsed, present: identity.present, byteSha256: identity.byteSha256 };
}
function checkedEvidence(evidence: ReceiptEvidence): { inputs: ResolutionInputs; resolution: EffectiveResolutionV2 } {
  const inventory = verifyAgentInventory(evidence.inventory);
  const catalog = buildCatalogSupport(evidence.catalog.catalog);
  if (inventory.digest !== evidence.inventory.digest || catalog.digest !== evidence.catalog.digest) fail("trusted-evidence-conflict");
  if (evidence.context.previousSelectionId !== (evidence.retained?.selectionId ?? null)) fail("previous-selection-conflict");
  migrationRecord(evidence);
  if (evidence.context.supportSource === "verified-snapshot" && (!evidence.predecessor || catalog.digest !== evidence.predecessor.catalog.digest)) fail("snapshot-catalog-conflict");
  const user = restoreUser(userSnapshot(evidence.user), { present: evidence.user.present,
    byteSha256: evidence.user.byteSha256, semanticSha256: evidence.user.semanticSha256 }, inventory);
  const inputs: ResolutionInputs = { policy: parseModelPolicy(evidence.policyText), inventory, catalog, user,
    retained: evidence.retained, agentDefaults: evidence.agentDefaults, refresh: evidence.refresh };
  return { inputs, resolution: resolveEffectiveSelections(inputs) };
}
function migrationRecord(evidence: ReceiptEvidence): ModelMigrationRecord {
  const previous = evidence.predecessor;
  if (!previous) {
    if (evidence.retained || evidence.context.previousSelectionId !== null) fail("migration-evidence-required");
    return { kind: "fresh", status: "not-required" };
  }
  assertVerifiedModelState(previous);
  const retention = (value: RetainedSelections) => ({ selectionId: value.selectionId,
    roles: Object.fromEntries(value.roles), agents: [...value.agents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) });
  if (!evidence.retained || previous.selectionId !== evidence.context.previousSelectionId
    || canonical(retention(previous.retained)) !== canonical(retention(evidence.retained))) fail("migration-retained-conflict");
  if (previous.recognizedOverlays.length !== previous.recognizedOverlayPins.length) fail("migration-overlay-conflict");
  const fields = (row: EffectiveSelection): EffectiveSelection => ({ defaultRealization: row.defaultRealization, effective: row.effective,
    defaultProvenance: row.defaultProvenance, provenance: row.provenance });
  return { kind: "predecessor", status: "verified-conflict-free", sourceVersion: previous.sourceVersion,
    sourceRevision: previous.sourceRevision, selectionId: previous.selectionId, oldPolicySha256: previous.resolution.policySha256,
    oldCatalogSha256: previous.recordedCatalogSha256, catalogSupportDigest: previous.catalog.digest,
    inventoryDigest: previous.inventoryDigest, originEvidenceSha256: previous.originEvidenceDigest, evidenceSha256: previous.evidenceDigest,
    outputs: previous.outputs, overlays: previous.recognizedOverlays.map((row, index) =>
      ({ overlayId: row.identity.overlayId, evidenceSha256: previous.recognizedOverlayPins[index]! })),
    retainedValues: { roles: Object.fromEntries(Object.entries(previous.resolution.roles).map(([role, row]) => [role, fields(row)])),
      agents: previous.resolution.agents.map(row => ({ ...row, ...fields(row) })) } };
}
export function dispatchModelSelection(resolution: EffectiveResolutionV2, selectionId: string) {
  if (!isDigest(selectionId)) fail("invalid-selection-identity");
  return { modelResolution: { ...resolution, selectionId }, projectedAgents: Object.fromEntries(resolution.agents.map(agent =>
    [agent.installedName, { role: agent.role, model: agent.effective.model, reasoning: agent.effective.effort }])) };
}
// Enforce the current adapter renderer's complete grammar, not a TOML substring
// search: only unindented root assignments of canonical JSON-quoted strings.
// Tables, quoted keys, multiline/literal strings, comments and duplicate fields
// are not emitted by renderAgent and cannot certify a native effective pair.
function managedAgentFields(content: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (line === "") continue;
    const match = /^(name|description|developer_instructions|model|model_reasoning_effort|sandbox_mode) = ("(?:[^"\\]|\\.)*")$/.exec(line);
    if (!match || fields.has(match[1]!) || /[\x00-\x1f\x7f]/.test(match[2]!)) fail("agent-generation-conflict");
    let value: unknown;
    try { value = JSON.parse(match[2]!); } catch { fail("agent-generation-conflict"); }
    if (typeof value !== "string" || JSON.stringify(value) !== match[2]
      || [...value].some(character => { const point = character.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; })) fail("agent-generation-conflict");
    fields.set(match[1]!, value);
  }
  if (!["name", "model", "model_reasoning_effort"].every(key => fields.has(key))) fail("agent-generation-conflict");
  return fields;
}
function validateRenderedSelection(outputs: readonly RenderedModelOutput[], resolution: EffectiveResolutionV2, selectionId: string): void {
  for (const output of outputs) {
    if (output.kind === "dispatch-snapshot") {
      const parsed = parseReceiptJson(output.content);
      if (!record(parsed)) fail("snapshot-generation-conflict");
      const expected = dispatchModelSelection(resolution, selectionId);
      if (canonical(parsed.modelResolution) !== canonical(expected.modelResolution)
        || canonical(parsed.projectedAgents) !== canonical(expected.projectedAgents)) fail("snapshot-generation-conflict");
    } else {
      const agent = resolution.agents.find(row => row.bindingId === output.sourceBinding);
      if (!agent) fail("output-binding-conflict");
      const fields = managedAgentFields(output.content);
      for (const [field, expected] of [["name", agent.installedName], ["model", agent.effective.model], ["model_reasoning_effort", agent.effective.effort]]) {
        if (fields.get(field!) !== expected) fail("agent-generation-conflict");
      }
    }
  }
}
export function createModelResolutionReceipt(evidence: ReceiptEvidence, outputs: readonly RenderedModelOutput[]): ModelResolutionReceiptV2 {
  const { inputs, resolution } = checkedEvidence(evidence), selectionId = modelSelectionId(resolution, evidence.context);
  if (evidence.capturedAt !== null && (typeof evidence.capturedAt !== "string" || !Number.isFinite(Date.parse(evidence.capturedAt)))) fail("invalid-catalog-capture");
  const version = (value: string | null): { value: string | null; status: "KNOWN" | "UNKNOWN" } => {
    if (value !== null && (typeof value !== "string" || !/^[A-Za-z0-9._+-]{1,100}$/.test(value))) fail("invalid-runtime-version");
    return { value, status: value === null ? "UNKNOWN" : "KNOWN" };
  };
  const manifest = createModelOutputManifest(outputs, selectionId, inputs.inventory);
  validateRenderedSelection(outputs, resolution, selectionId);
  const receipt: ModelResolutionReceiptV2 = { schemaVersion: 2, persistenceVersion: 1, selectionId, inputs: { ...evidence.context, policySha256: resolution.policySha256,
    inventoryDigest: resolution.inventoryDigest, catalogDigest: resolution.catalogDigest, agentDefaultsDigest: resolution.agentDefaultsDigest,
    user: { snapshot: userSnapshot(inputs.user), identity: resolution.userIdentity }, refresh: evidence.refresh === true },
    catalog: { snapshot: inputs.catalog.catalog, digest: inputs.catalog.digest, capturedAt: evidence.capturedAt, captureStatus: evidence.capturedAt === null ? "UNKNOWN" : "KNOWN",
      runtimeVersion: version(evidence.runtimeVersion), collectorVersion: version(evidence.collectorVersion) },
    inventory: { digest: inputs.inventory.digest, agents: inputs.inventory.agents }, resolution, outputs: manifest, migration: migrationRecord(evidence) };
  if (Buffer.byteLength(canonical(receipt)) > 1_048_576) fail("receipt-too-large");
  return receipt;
}
export interface InstalledReceiptSourceEvidence {
  sourceRevision: string; policyText: string; inventory: AgentInventory; agentDefaults?: ReadonlyMap<string, ModelChoice>;
}
export interface InstalledV2Evidence {
  kind: "v2"; receiptText: string; expectedReceiptSha256: string;
  evidence: InstalledReceiptSourceEvidence; actualOutputs: readonly RenderedModelOutput[];
  overlay?: InstalledObserverOverlayEvidence;
}
export interface InstalledV1Evidence {
  kind: "v1"; resolutionText: string; policyText: string; catalog: unknown; inventory: AgentInventory;
  actualOutputs: readonly RenderedModelOutput[];
  // This pin must come from an independent recorded/public predecessor source,
  // never be computed by the caller from current generated files for adoption.
  evidenceText?: string; expectedEvidenceSha256?: string;
  overlay?: InstalledObserverOverlayEvidence;
}
function verifiedState(resolution: EffectiveResolutionV2, selectionId: string, digest: string,
  user: UserModelPolicy, catalog: CatalogSupport, sourceVersion: 1 | 2,
  inventory: AgentInventory, outputs: readonly ModelOutputIdentity[], sourceRevision: string, receipt?: ModelResolutionReceiptV2,
  recordedCatalogSha256 = catalog.digest, overlay?: { checkpoint: ObserverModelOverlay; pin: string }): VerifiedInstalledModelState {
  return registerVerifiedState({ [VERIFIED]: true, sourceVersion, selectionId, evidenceDigest: overlay?.pin ?? digest, resolution, user, catalog,
    inventoryDigest: resolution.inventoryDigest, inventory, outputs, sourceRevision, receipt, recognizedOverlays: overlay ? [overlay.checkpoint] : [],
    originEvidenceDigest: digest, recordedCatalogSha256, recognizedOverlayPins: overlay ? [overlay.pin] : [], retained: { selectionId,
      roles: new Map(Object.entries(resolution.roles).map(([role, row]) => [role as keyof typeof resolution.roles, row.defaultRealization])),
      agents: new Map(resolution.agents.map(agent => [agent.bindingId, { ...agent, defaultRealization: agent.defaultRealization }])) } });
}
// Receipt text/output bytes are untrusted. The hash pin, public source inventory,
// policy/catalog and retained/default evidence must be independently supplied.
export function verifyInstalledModelState(input: InstalledV2Evidence | InstalledV1Evidence): VerifiedInstalledModelState {
  if (input.kind !== "v1" && input.kind !== "v2") fail("invalid-installed-kind");
  const allowed = input.kind === "v2" ? ["kind", "receiptText", "expectedReceiptSha256", "evidence", "actualOutputs", "overlay"]
    : ["kind", "resolutionText", "policyText", "catalog", "inventory", "actualOutputs", "evidenceText", "expectedEvidenceSha256", "overlay"];
  keys(input, allowed, allowed.filter(key => !["overlay", "evidenceText", "expectedEvidenceSha256"].includes(key)));
  const metadata = input.kind === "v2" ? validateReceiptMetadata(input) : validateLegacyMetadata(input);
  let outputs: readonly ModelOutputIdentity[] = metadata.outputs;
  let overlay: { checkpoint: ObserverModelOverlay; pin: string } | undefined;
  if (input.overlay) {
    const checkpoint = validatePersistedOverlay(metadata, input.overlay, input.actualOutputs);
    outputs = checkpoint.outputs; overlay = { checkpoint, pin: input.overlay.expectedOverlaySha256 };
  } else {
    verifyModelOutputManifest(outputs, input.actualOutputs, metadata.selectionId, metadata.inventory);
    if (metadata.sourceVersion === 2) validateRenderedSelection(input.actualOutputs, metadata.resolution, metadata.selectionId);
  }
  return verifiedState(metadata.resolution, metadata.selectionId, metadata.originEvidenceDigest, metadata.user, metadata.catalog,
    metadata.sourceVersion, metadata.inventory, outputs, metadata.sourceRevision, metadata.receipt, metadata.recordedCatalogSha256, overlay);
}

interface InstalledMetadata {
  sourceVersion: 1 | 2; selectionId: string; originEvidenceDigest: string; sourceRevision: string;
  resolution: EffectiveResolutionV2; user: UserModelPolicy; catalog: CatalogSupport; inventory: AgentInventory;
  outputs: ModelOutputIdentity[]; recordedCatalogSha256: string; receipt?: ModelResolutionReceiptV2;
}
const identityFields = ["sourceAgentId", "bindingId", "sourcePath", "sourceProvider", "installedName", "role", "securityPolicyDigest", "sourceSha256", "codeBound", "capabilityKey"];
const selectionFields = ["defaultRealization", "effective", "defaultProvenance", "provenance"];
function validateSelectionFields(value: unknown): asserts value is EffectiveSelection {
  if (!record(value)) fail("invalid-retained-selection");
  const pair = (raw: unknown, nullable: boolean): void => {
    keys(raw, ["model", "effort"]);
    if (!(nullable && raw.model === null) && (typeof raw.model !== "string" || raw.model === "inherit"
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,199}$/.test(raw.model)
      || ["__proto__", "prototype", "constructor"].includes(raw.model))) fail("invalid-retained-selection");
    if (!(nullable && raw.effort === null) && (typeof raw.effort !== "string" || !EFFORTS.includes(raw.effort))) fail("invalid-retained-selection");
  };
  pair(value.defaultRealization, true); pair(value.effective, false);
  for (const raw of [value.defaultProvenance, value.provenance]) {
    keys(raw, ["model", "effort"]);
    for (const field of [raw.model, raw.effort]) {
      keys(field, ["origin", "inputKey", "inputDigest"]);
      if (!["shipped-role", "shipped-agent", "retained-managed", "user-role", "user-agent"].includes(field.origin as string)
        || !isDigest(field.inputDigest) || typeof field.inputKey !== "string" || field.inputKey.length > 1024
        || !/^(?:roles\.(?:root|designer|builder|support|researcher|observer|broker)|agents\.[A-Za-z0-9][A-Za-z0-9._:@/-]*)\.(?:model|effort)$/.test(field.inputKey)) fail("invalid-retained-provenance");
    }
  }
}
function retainedFromMigration(raw: unknown, previousSelectionId: unknown): RetainedSelections | undefined {
  if (!record(raw)) fail("invalid-migration-record");
  if (raw.kind === "fresh") {
    keys(raw, ["kind", "status"]);
    if (raw.status !== "not-required" || previousSelectionId !== null) fail("invalid-migration-record");
    return undefined;
  }
  keys(raw, ["kind", "status", "sourceVersion", "sourceRevision", "selectionId", "oldPolicySha256", "oldCatalogSha256", "catalogSupportDigest",
    "inventoryDigest", "originEvidenceSha256", "evidenceSha256", "outputs", "overlays", "retainedValues"]);
  if (raw.kind !== "predecessor" || raw.status !== "verified-conflict-free" || ![1, 2].includes(raw.sourceVersion as number)
    || typeof raw.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(raw.sourceRevision)
    || !isDigest(raw.selectionId) || raw.selectionId !== previousSelectionId
    || ["oldPolicySha256", "oldCatalogSha256", "catalogSupportDigest", "inventoryDigest", "originEvidenceSha256", "evidenceSha256"].some(key => !isDigest(raw[key]))) fail("invalid-migration-record");
  if (raw.sourceVersion === 2 && raw.oldCatalogSha256 !== raw.catalogSupportDigest) fail("invalid-migration-record");
  if (!Array.isArray(raw.overlays) || raw.overlays.length > 1) fail("invalid-migration-overlay");
  for (const row of raw.overlays) {
    keys(row, ["overlayId", "evidenceSha256"]);
    if (!isDigest(row.overlayId) || !isDigest(row.evidenceSha256) || row.evidenceSha256 !== raw.evidenceSha256) fail("invalid-migration-overlay");
  }
  if (!raw.overlays.length && raw.originEvidenceSha256 !== raw.evidenceSha256) fail("invalid-migration-overlay");
  keys(raw.retainedValues, ["roles", "agents"]); keys(raw.retainedValues.roles, ROLES);
  for (const row of Object.values(raw.retainedValues.roles)) { keys(row, selectionFields); validateSelectionFields(row); }
  if (!Array.isArray(raw.retainedValues.agents) || raw.retainedValues.agents.length > 512) fail("invalid-retained-agents");
  const identities = raw.retainedValues.agents.map(row => {
    keys(row, [...identityFields, ...selectionFields], [...identityFields.filter(key => key !== "capabilityKey"), ...selectionFields]);
    validateSelectionFields(row);
    return Object.fromEntries(identityFields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])) as unknown as AgentIdentity;
  });
  const inventory = buildAgentInventory(identities.map(({ sourceAgentId: _id, bindingId: _binding, ...source }) => source));
  if (inventory.digest !== raw.inventoryDigest || canonical(inventory.agents) !== canonical(identities)) fail("migration-inventory-conflict");
  validateOutputIdentities(raw.outputs as ModelOutputIdentity[], raw.selectionId, inventory);
  const migration = raw as unknown as Exclude<ModelMigrationRecord, { kind: "fresh" }>;
  return { selectionId: migration.selectionId,
    roles: new Map(ROLES.map(role => [role, migration.retainedValues.roles[role]!.defaultRealization])),
    agents: new Map(migration.retainedValues.agents.map(row => [row.bindingId, { ...row, defaultRealization: row.defaultRealization }])) };
}
function validateReceiptMetadata(input: InstalledV2Evidence): InstalledMetadata {
  if (!isDigest(input.expectedReceiptSha256) || sha(input.receiptText) !== input.expectedReceiptSha256) fail("receipt-byte-conflict");
  keys(input.evidence, ["sourceRevision", "policyText", "inventory", "agentDefaults"], ["sourceRevision", "policyText", "inventory"]);
  const raw = parseReceiptJson(input.receiptText);
  keys(raw, ["schemaVersion", "persistenceVersion", "selectionId", "inputs", "catalog", "inventory", "resolution", "outputs", "migration"]);
  if (raw.schemaVersion !== 2 || raw.persistenceVersion !== 1 || !isDigest(raw.selectionId)) fail("invalid-receipt-version");
  keys(raw.inputs, ["sourceRevision", "previousSelectionId", "supportSource", "policySha256", "inventoryDigest", "catalogDigest", "agentDefaultsDigest", "user", "refresh"]);
  keys(raw.inputs.user, ["snapshot", "identity"]);
  keys(raw.catalog, ["snapshot", "digest", "capturedAt", "captureStatus", "runtimeVersion", "collectorVersion"]);
  keys(raw.inventory, ["digest", "agents"]);
  if (typeof raw.inputs.refresh !== "boolean" || raw.inputs.sourceRevision !== input.evidence.sourceRevision) fail("installed-source-conflict");
  const inventory = verifyAgentInventory(input.evidence.inventory), policy = parseModelPolicy(input.evidence.policyText);
  if (inventory.digest !== raw.inventory.digest || canonical(inventory.agents) !== canonical(raw.inventory.agents)) fail("inventory-generation-conflict");
  const catalog = buildCatalogSupport(raw.catalog.snapshot);
  if (canonical(catalog.catalog) !== canonical(raw.catalog.snapshot) || catalog.digest !== raw.catalog.digest
    || catalog.digest !== raw.inputs.catalogDigest) fail("catalog-generation-conflict");
  if (raw.catalog.capturedAt !== null && (typeof raw.catalog.capturedAt !== "string" || !Number.isFinite(Date.parse(raw.catalog.capturedAt)))
    || raw.catalog.captureStatus !== (raw.catalog.capturedAt === null ? "UNKNOWN" : "KNOWN")) fail("invalid-catalog-capture");
  for (const version of [raw.catalog.runtimeVersion, raw.catalog.collectorVersion]) {
    keys(version, ["value", "status"]);
    if (version.value !== null && (typeof version.value !== "string" || !/^[A-Za-z0-9._+-]{1,100}$/.test(version.value))
      || version.status !== (version.value === null ? "UNKNOWN" : "KNOWN")) fail("invalid-runtime-version");
  }
  const retained = retainedFromMigration(raw.migration, raw.inputs.previousSelectionId);
  if (raw.inputs.supportSource === "verified-snapshot" && (!retained || !record(raw.migration) || catalog.digest !== raw.migration.catalogSupportDigest)) fail("snapshot-catalog-conflict");
  const user = restoreUser(raw.inputs.user.snapshot, raw.inputs.user.identity as EffectiveResolutionV2["userIdentity"], inventory);
  const resolution = resolveEffectiveSelections({ policy, inventory, catalog, user, agentDefaults: input.evidence.agentDefaults,
    retained, refresh: raw.inputs.refresh });
  const context = { sourceRevision: raw.inputs.sourceRevision, previousSelectionId: raw.inputs.previousSelectionId, supportSource: raw.inputs.supportSource } as SelectionIdentityContext;
  const selectionId = modelSelectionId(resolution, context);
  if (selectionId !== raw.selectionId || canonical(resolution) !== canonical(raw.resolution)
    || resolution.policySha256 !== raw.inputs.policySha256 || resolution.inventoryDigest !== raw.inputs.inventoryDigest
    || resolution.agentDefaultsDigest !== raw.inputs.agentDefaultsDigest) fail("receipt-generation-conflict");
  const outputs = validateOutputIdentities(raw.outputs as ModelOutputIdentity[], selectionId, inventory);
  return { sourceVersion: 2, selectionId, originEvidenceDigest: input.expectedReceiptSha256, sourceRevision: input.evidence.sourceRevision,
    resolution, user, catalog, inventory, outputs, recordedCatalogSha256: catalog.digest, receipt: raw as unknown as ModelResolutionReceiptV2 };
}

// Explicitly trusted adapter evidence, never taken from receipt/user JSON.
export interface ObserverOverlayAuthority {
  bindingId: string; sourceAgentId: string; sourcePath: string; sourceProvider: string; installedName: string;
  role: "observer"; securityPolicyDigest: string; sourceRevision: string; sourceSha256: string; expectedObserverSha256: string;
}
interface ObserverCheckpointIdentity {
  baseSelectionId: string; originEvidenceSha256: string; predecessorEvidenceSha256: string; predecessorOutputsDigest: string;
  authority: ObserverOverlayAuthority; effective: ModelEffort;
  invariants: { observerStableFieldsSha256: string; snapshotWithoutOverlaySha256: string }; overlayId: string;
}
function observerAuthority(base: Pick<InstalledMetadata, "inventory" | "resolution">, authority: ObserverOverlayAuthority): ModelEffort {
  keys(authority, ["bindingId", "sourceAgentId", "sourcePath", "sourceProvider", "installedName", "role", "securityPolicyDigest",
    "sourceRevision", "sourceSha256", "expectedObserverSha256"]);
  const agent = base.inventory.agents.find(row => row.bindingId === authority.bindingId);
  if (!agent || authority.sourceAgentId !== "codex-obs" || authority.sourcePath !== "codex/agents/codex-obs.md"
    || authority.role !== "observer" || agent.role !== "observer"
    || ["sourceAgentId", "sourcePath", "sourceProvider", "installedName", "securityPolicyDigest"].some(key =>
      authority[key as keyof ObserverOverlayAuthority] !== agent[key as keyof typeof agent])
    || !/^[a-f0-9]{40}$/.test(authority.sourceRevision) || !isDigest(authority.sourceSha256)
    || !isDigest(authority.expectedObserverSha256)) fail("overlay-binding-conflict");
  const effective = base.resolution.agents.find(row => row.bindingId === agent.bindingId)?.effective;
  if (!effective) fail("overlay-binding-conflict");
  return effective;
}
function snapshotWithoutOverlay(text: string): Record<string, unknown> {
  const parsed = parseReceiptJson(text);
  if (!record(parsed)) fail("snapshot-generation-conflict");
  const { modelSelectionOverlay: _overlay, ...snapshot } = parsed;
  return snapshot;
}
function stableObserverFields(content: string): Record<string, string> {
  const fields = managedAgentFields(content);
  if (fields.get("sandbox_mode") !== "read-only") fail("overlay-security-conflict");
  return Object.fromEntries([...fields].filter(([key]) => key !== "description" && key !== "developer_instructions"));
}
function observerOverlayIdentity(base: VerifiedInstalledModelState, authority: ObserverOverlayAuthority, previousText: string): ObserverCheckpointIdentity {
  assertVerifiedModelState(base);
  const effective = observerAuthority(base, authority), previous = parseReceiptJson(previousText);
  if (!record(previous)) fail("snapshot-generation-conflict");
  const prior = base.recognizedOverlays[0];
  if (prior ? canonical(previous.modelSelectionOverlay) !== canonical(prior.identity) : Object.hasOwn(previous, "modelSelectionOverlay")) fail("overlay-generation-conflict");
  const invariants = prior?.identity.invariants ?? {
    observerStableFieldsSha256: modelEvidenceDigest({ name: authority.installedName, model: effective.model,
      model_reasoning_effort: effective.effort, sandbox_mode: "read-only" }),
    snapshotWithoutOverlaySha256: modelEvidenceDigest(snapshotWithoutOverlay(previousText)) };
  if (modelEvidenceDigest(snapshotWithoutOverlay(previousText)) !== invariants.snapshotWithoutOverlaySha256) fail("overlay-generation-conflict");
  const identity = { baseSelectionId: base.selectionId, originEvidenceSha256: base.originEvidenceDigest,
    predecessorEvidenceSha256: base.evidenceDigest, predecessorOutputsDigest: modelEvidenceDigest(base.outputs),
    authority: { ...authority }, effective: { ...effective }, invariants: { ...invariants } };
  return { ...identity, overlayId: modelEvidenceDigest(identity) };
}
export function observerOverlaySnapshot(previousText: string, base: VerifiedInstalledModelState, authority: ObserverOverlayAuthority): string {
  const identity = observerOverlayIdentity(base, authority, previousText), previous = parseReceiptJson(previousText);
  if (!record(previous)) fail("snapshot-generation-conflict");
  return canonical({ ...previous, modelSelectionOverlay: identity });
}
export interface ObserverModelOverlay {
  schemaVersion: 2; kind: "observer-model-selection";
  selectionId: string; effectivePairUnchanged: true;
  identity: ObserverCheckpointIdentity;
  outputs: readonly ModelOutputIdentity[];
}
interface ObserverOverlayInputs {
  base: VerifiedInstalledModelState; authority: ObserverOverlayAuthority;
  predecessorOutputs: readonly RenderedModelOutput[]; outputs: readonly RenderedModelOutput[];
}
export interface InstalledObserverOverlayEvidence {
  authority: ObserverOverlayAuthority;
  overlayText: string; expectedOverlaySha256: string;
}
export function createObserverModelOverlay(input: ObserverOverlayInputs): ObserverModelOverlay {
  const { base, authority, predecessorOutputs, outputs } = input;
  assertVerifiedModelState(base);
  verifyModelOutputManifest(base.outputs, predecessorOutputs, base.selectionId, base.inventory);
  const previousSnapshot = predecessorOutputs.find(row => row.target === MODEL_DISPATCH_SNAPSHOT_TARGET)!;
  const identity = observerOverlayIdentity(base, authority, previousSnapshot.content);
  const manifest = createModelOutputManifest(outputs, base.selectionId, base.inventory);
  const target = `agents/${authority.installedName}.toml`;
  const oldAgent = predecessorOutputs.find(row => row.target === target)!;
  const nextAgent = outputs.find(row => row.target === target)!;
  if (sha(nextAgent.content) !== authority.expectedObserverSha256) fail("overlay-output-conflict");
  if (modelEvidenceDigest(stableObserverFields(oldAgent.content)) !== identity.invariants.observerStableFieldsSha256
    || modelEvidenceDigest(stableObserverFields(nextAgent.content)) !== identity.invariants.observerStableFieldsSha256) fail("overlay-security-conflict");
  validateRenderedSelection([nextAgent], base.resolution, base.selectionId);
  const snapshot = outputs.find(row => row.target === MODEL_DISPATCH_SNAPSHOT_TARGET)!;
  if (canonical(parseReceiptJson(snapshot.content)) !== observerOverlaySnapshot(previousSnapshot.content, base, authority)) fail("overlay-generation-conflict");
  for (const output of manifest) {
    if (output.target !== target && output.target !== MODEL_DISPATCH_SNAPSHOT_TARGET
      && canonical(output) !== canonical(base.outputs.find(row => row.target === output.target))) fail("overlay-unrelated-output-conflict");
  }
  const checkpoint: ObserverModelOverlay = { schemaVersion: 2, kind: "observer-model-selection", selectionId: base.selectionId, effectivePairUnchanged: true,
    identity, outputs: manifest };
  if (Buffer.byteLength(canonical(checkpoint)) > 1_048_576) fail("overlay-too-large");
  return checkpoint;
}
export function verifyObserverModelOverlay(input: ObserverOverlayInputs & { overlayText: string; expectedOverlaySha256: string }): VerifiedInstalledModelState {
  if (!isDigest(input.expectedOverlaySha256) || sha(input.overlayText) !== input.expectedOverlaySha256) fail("overlay-byte-conflict");
  const expected = createObserverModelOverlay(input);
  if (canonical(parseReceiptJson(input.overlayText)) !== canonical(expected)) fail("overlay-generation-conflict");
  return registerVerifiedState({ ...input.base, evidenceDigest: input.expectedOverlaySha256, outputs: expected.outputs,
    recognizedOverlays: [expected], recognizedOverlayPins: [input.expectedOverlaySha256] });
}

function validatePersistedOverlay(base: InstalledMetadata, input: InstalledObserverOverlayEvidence, actual: readonly RenderedModelOutput[]): ObserverModelOverlay {
  keys(input, ["authority", "overlayText", "expectedOverlaySha256"]);
  if (!isDigest(input.expectedOverlaySha256) || sha(input.overlayText) !== input.expectedOverlaySha256) fail("overlay-byte-conflict");
  const raw = parseReceiptJson(input.overlayText);
  keys(raw, ["schemaVersion", "kind", "selectionId", "effectivePairUnchanged", "identity", "outputs"]);
  if (raw.schemaVersion !== 2 || raw.kind !== "observer-model-selection" || raw.selectionId !== base.selectionId || raw.effectivePairUnchanged !== true) fail("overlay-generation-conflict");
  keys(raw.identity, ["baseSelectionId", "originEvidenceSha256", "predecessorEvidenceSha256", "predecessorOutputsDigest", "authority", "effective", "invariants", "overlayId"]);
  keys(raw.identity.invariants, ["observerStableFieldsSha256", "snapshotWithoutOverlaySha256"]);
  const effective = observerAuthority(base, input.authority);
  if (raw.identity.baseSelectionId !== base.selectionId || raw.identity.originEvidenceSha256 !== base.originEvidenceDigest
    || !isDigest(raw.identity.predecessorEvidenceSha256) || !isDigest(raw.identity.predecessorOutputsDigest)
    || !isDigest(raw.identity.invariants.observerStableFieldsSha256) || !isDigest(raw.identity.invariants.snapshotWithoutOverlaySha256)
    || canonical(raw.identity.authority) !== canonical(input.authority) || canonical(raw.identity.effective) !== canonical(effective)) fail("overlay-generation-conflict");
  const { overlayId, ...payload } = raw.identity;
  if (!isDigest(overlayId) || modelEvidenceDigest(payload) !== overlayId) fail("overlay-generation-conflict");
  const checkpoint = raw as unknown as ObserverModelOverlay;
  const manifest = validateOutputIdentities(checkpoint.outputs, base.selectionId, base.inventory);
  verifyModelOutputManifest(manifest, actual, base.selectionId, base.inventory);
  const target = `agents/${input.authority.installedName}.toml`;
  for (const output of manifest) if (output.target !== target && output.target !== MODEL_DISPATCH_SNAPSHOT_TARGET
    && canonical(output) !== canonical(base.outputs.find(row => row.target === output.target))) fail("overlay-unrelated-output-conflict");
  const observer = actual.find(row => row.target === target)!, snapshot = actual.find(row => row.target === MODEL_DISPATCH_SNAPSHOT_TARGET)!;
  if (sha(observer.content) !== input.authority.expectedObserverSha256
    || modelEvidenceDigest(stableObserverFields(observer.content)) !== checkpoint.identity.invariants.observerStableFieldsSha256) fail("overlay-security-conflict");
  validateRenderedSelection([observer], base.resolution, base.selectionId);
  const parsed = parseReceiptJson(snapshot.content);
  if (!record(parsed) || canonical(parsed.modelSelectionOverlay) !== canonical(checkpoint.identity)
    || modelEvidenceDigest(snapshotWithoutOverlay(snapshot.content)) !== checkpoint.identity.invariants.snapshotWithoutOverlaySha256) fail("overlay-generation-conflict");
  if (base.sourceVersion === 2) validateRenderedSelection(actual, base.resolution, base.selectionId);
  return checkpoint;
}

function validateLegacyMetadata(input: InstalledV1Evidence): InstalledMetadata {
  const inventory = verifyAgentInventory(input.inventory);
  if (input.evidenceText === undefined || input.expectedEvidenceSha256 === undefined || input.catalog === undefined || input.catalog === null) fail("migration-evidence-insufficient");
  if (!isDigest(input.expectedEvidenceSha256) || sha(input.evidenceText) !== input.expectedEvidenceSha256) fail("migration-evidence-conflict");
  const recorded = parseReceiptJson(input.evidenceText), old = parseReceiptJson(input.resolutionText);
  if (!record(recorded) || !Object.hasOwn(recorded, "roleDefaults") || !Object.hasOwn(recorded, "agents")) fail("migration-evidence-insufficient");
  keys(recorded, ["schemaVersion", "sourceRevision", "policySha256", "catalogSha256", "resolutionSha256", "inventoryDigest", "outputs", "roleDefaults", "agents"]);
  keys(old, ["schemaVersion", "policySha256", "catalogSha256", "resolvedAt", "roles", "supportedModels"]);
  if (recorded.schemaVersion !== 1 || old.schemaVersion !== 1 || typeof recorded.sourceRevision !== "string"
    || !/^[a-f0-9]{40}$/.test(recorded.sourceRevision) || recorded.resolutionSha256 !== sha(input.resolutionText)
    || recorded.inventoryDigest !== inventory.digest || typeof old.resolvedAt !== "string" || !Number.isFinite(Date.parse(old.resolvedAt))) fail("legacy-identity-conflict");
  let checked: ReturnType<typeof resolveModels>;
  try { checked = resolveModels(parseModelPolicy(input.policyText), input.catalog); } catch { fail("legacy-policy-conflict"); }
  if (checked.policySha256 !== recorded.policySha256 || old.policySha256 !== checked.policySha256) fail("legacy-policy-conflict");
  if (checked.catalogSha256 !== recorded.catalogSha256 || old.catalogSha256 !== checked.catalogSha256
    || canonical(old.roles) !== canonical(checked.roles) || canonical(old.supportedModels) !== canonical(checked.supportedModels)) fail("legacy-resolution-conflict");
  const catalog = buildCatalogSupport(input.catalog), user = parseUserModelPolicy(undefined, inventory);
  const selectionId = modelEvidenceDigest({ schemaVersion: 1, evidenceDigest: input.expectedEvidenceSha256, sourceRevision: recorded.sourceRevision });
  if (!Array.isArray(recorded.outputs)) fail("migration-evidence-insufficient");
  const expectedOutputs = recorded.outputs.map(row => {
    keys(row, ["target", "kind", "sourceBinding", "sha256"]);
    return { ...row, selectionId } as unknown as ModelOutputIdentity;
  });
  const outputs = validateOutputIdentities(expectedOutputs, selectionId, inventory);
  keys(recorded.roleDefaults, ROLES);
  const defaultPair = (value: unknown): DefaultRealization => {
    keys(value, ["model", "effort"]);
    if (value.model !== null && (typeof value.model !== "string" || catalog.byAlias.get(value.model)?.model !== value.model)
      || value.effort !== null && (typeof value.effort !== "string" || !EFFORTS.includes(value.effort))) fail("legacy-default-conflict");
    const pair = value as unknown as DefaultRealization;
    if (pair.model !== null && pair.effort !== null) validateSupportedPair(pair as ModelEffort, catalog);
    return { ...pair };
  };
  const selection = (base: DefaultRealization, effective: ModelEffort, key: string): EffectiveSelection => {
    const origin = (field: string) => ({ origin: "retained-managed" as const, inputKey: `${key}.${field}`, inputDigest: selectionId });
    return { defaultRealization: base, effective, defaultProvenance: { model: origin("model"), effort: origin("effort") },
      provenance: { model: origin("model"), effort: origin("effort") } };
  };
  const roles = {} as EffectiveResolutionV2["roles"];
  for (const role of ROLES) {
    const base = defaultPair(recorded.roleDefaults[role]), effective = { model: checked.roles[role].model, effort: checked.roles[role].reasoning };
    if (base.model !== null && base.model !== effective.model || base.effort !== null && base.effort !== effective.effort) fail("legacy-default-conflict");
    roles[role] = selection(base, effective, `roles.${role}`);
  }
  if (!Array.isArray(recorded.agents) || recorded.agents.length !== inventory.agents.length) fail("migration-evidence-insufficient");
  const legacyAgents = new Map<string, { effective: ModelEffort; defaultRealization: DefaultRealization }>();
  for (const row of recorded.agents) {
    keys(row, ["bindingId", "effective", "defaultRealization"]);
    if (typeof row.bindingId !== "string" || legacyAgents.has(row.bindingId)
      || !inventory.agents.some(agent => agent.bindingId === row.bindingId)) fail("legacy-binding-conflict");
    keys(row.effective, ["model", "effort"]);
    if (typeof row.effective.model !== "string" || catalog.byAlias.get(row.effective.model)?.model !== row.effective.model
      || typeof row.effective.effort !== "string") fail("legacy-selection-conflict");
    const effective = row.effective as unknown as ModelEffort;
    validateSupportedPair(effective, catalog);
    legacyAgents.set(row.bindingId, { effective: { ...effective }, defaultRealization: defaultPair(row.defaultRealization) });
  }
  const resolution: EffectiveResolutionV2 = { schemaVersion: 2, policySha256: checked.policySha256, inventoryDigest: inventory.digest,
    catalogDigest: catalog.digest, userIdentity: { present: false, byteSha256: null, semanticSha256: user.semanticSha256 },
    agentDefaultsDigest: sha("[]"), roles, agents: inventory.agents.map(agent => {
      const row = legacyAgents.get(agent.bindingId)!;
      return { ...agent, ...selection(row.defaultRealization, row.effective, `agents.${agent.bindingId}`) };
    }), supportedModels: catalog.supportedModels };
  return { sourceVersion: 1, selectionId, originEvidenceDigest: input.expectedEvidenceSha256, resolution, user, catalog,
    inventory: inventory, outputs, sourceRevision: recorded.sourceRevision, recordedCatalogSha256: checked.catalogSha256 };
}
