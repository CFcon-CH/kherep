#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { productEnv } from "../lib/product-env.mts";
import { nativeWorkspacePath } from "../lib/workspace-path.mts";
import { resolveTarget as resolveCredentialTarget } from "../bootstrap/atl-credential-format.mts";
import { ATLASSIAN_MCP_SERVER, resolveTokenBinding, tokenBindingProblem } from "../lib/atlassian-mcp-binding.mts";
import { mergeLocalInferenceConfig } from "../bootstrap/render-profile.mts";
import { intercomValues, renderIntercom } from "../bootstrap/render-intercom.mts";
import * as registryBridgeModule from "../modules/mcp-auth-bridge/registry-http-wrapper.mts";
import { setPluginEnabled } from "./lib/plugin-config.mts";
import {
  atlassianMcpServer, hasManagedAtlassianTable, managedAtlassianTokenFile, PREDECESSOR_NATIVE_ATLASSIAN,
} from "./lib/atlassian-mcp.mts";
import { copyGithubBroker } from "../lib/github-broker-projection.mts";
import { copyObservationBroker, renderObservationHook } from "./lib/observation-projection.mts";
import { copyObservationSnapshot } from "./lib/observation-source.mts";
import { componentHash } from "./lib/component-hash.mts";
import { prepareManagedConfig } from "./lib/config-preservation.mts";
import { atlassianDestructiveGuard, command } from "./lib/parity-config.mts";
import type { Capabilities, McpCompatibilityOptions, PluginMcpServer, RunCodex } from "./lib/contracts.mts";
import { controlPlaneRulesPath, launcherRule, renderControlPlaneRules } from "./lib/control-plane-rules.mts";
import { controlPlaneOutbox } from "./lib/outbox-writable-root.mts";
import { pointerFile, renderControlPlanePointer } from "./lib/control-plane-pointer.mts";
import { InstallTransaction } from "./lib/install-transaction.mts";
import * as localPlugin from "./lib/local-plugin.mts";
import * as managedConfig from "./lib/managed-config.mts";
import { memoryProviderFile, resolveMemoryProvider } from "./lib/memory-provider.mts";
import { selectModelResolution } from "./lib/model-install-state.mts";
import { CatalogReadError, readAvailableModels } from "./lib/model-catalog-process.mts";
import { record, resolveCapabilities } from "./lib/model-policy.mts";
import { projectOperatorBinding } from "./lib/mcp-operator-binding.mts";
import { projectRegistry } from "./lib/mcp-registry-projection.mts";
import { retiredCentralBrainRender } from "./lib/retired-central-brain.mts";
import { readRetiredWorkspaceEntries, retireWorkspaceEntries } from "./lib/retired-workspace.mts";
import * as parityProjection from "./lib/parity-projection.mts";
import { resolveRegistryFile } from "./lib/registry-file.mts";
import { assertResearchHookParity } from "./lib/research-hook-parity.mts";
import { setMarkedBlock } from "./lib/text-merge.mts";

export { setMarkedBlock };

export const AGENTS_START = "<!-- kherep:start -->";
const AGENTS_END = "<!-- kherep:end -->";
export const USER_START = "<!-- kherep-user-parity:start -->";
const USER_END = "<!-- kherep-user-parity:end -->";
export const CONFIG_START = "# >>> Kherep Codex Maestro >>>";
const CONFIG_END = "# <<< Kherep Codex Maestro <<<";
export const LOCAL_PLUGIN_ID = "kherep-maestro@kherep";
// The v2 Atlassian remote MCP server, rendered only with the optional Atlassian
// tool set, through the Codex service account (issue #376).
export { ATLASSIAN_MCP_SERVER };
const RETIRED_MCP_SERVERS = ["claude-baton"];
const SHARED_HOOKS = [
  "commit-guard.mts", "deploy-guard.mts", "playwright-file-guard.mts", "main-checkout-guard.mts",
  "atlassian-destructive-guard.mts",
  "manifest-watch.mts", "loc-watch.mts", "umlaut-translit-watch.mts", "simplify-nudge.mts",
];

// Projection files whose names changed with the TypeScript migration
// (OP-1122 hooks, OP-1123 runner and MCP bridge). The projection copies files
// by name, so without this list a rename would leave the old file behind.
const RETIRED_TARGETS = [
  path.join("hooks", "kherep-maestro-context.js"),
  ...["cbm-reminder", "dispatch-contract-guard", "precompact-checkpoint", "acceptance-gate", "observation-turn-completion", "hook-adapter", "privacy-boundary-guard"]
    .map((name) => path.join("hooks", "kherep-maestro", `codex-${name}.js`)),
  // OP-1138. The four PostToolUse nudges became .mts. The projection copies by
  // name, so their old .js copies would survive under hooks/kherep-maestro.
  // Issue #237: the three shared Claude guards became .mts the same way.
  ...["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge",
    "commit-guard", "deploy-guard", "playwright-file-guard"]
    .map((name) => path.join("hooks", "kherep-maestro", `${name}.js`)),
  path.join("orchestra", "registry-http-bridge.js"),
  path.join("orchestra", "supergateway-secret-wrapper.js"),
  path.join("kherep", "local-inference", "runner.js"),
];

export { renderObservationHook };

// Everything the installer accepts from the CLI, the environment and the
// tests. The command wrappers (runCodex, resolveRegistryRuntime) exist so a
// test never touches a real Codex binary.
export interface InstallOptions {
  // A complete metadata-only model/list catalog, injected by the async CLI or tests.
  modelCatalog?: unknown;
  refreshModels?: boolean;
  memoryProvider?: unknown;
  memoryProviderConfig?: string;
  codexHome?: string;
  claudeConfigDir?: string;
  claudeRegistryFile?: string;
  registryFile?: string;
  workspace?: string;
  homeDir?: string;
  platform?: string;
  nodePath?: string;
  skipPluginRegistration?: boolean;
  installAtlassianTools?: boolean;
  // The Codex service account's Atlassian MCP API key file; by default
  // KHEREP_ATL_MCP_TOKEN_FILE_CODEX, else <CODEX_HOME>/kherep/atl-mcp-credential-codex.txt.
  atlassianMcpTokenFile?: string;
  authorizeObservationPublishing?: boolean;
  runCodex?: RunCodex;
  resolveRegistryRuntime?: () => unknown;
  afterWrite?: (writes: number) => void;
  retiredManifest?: string;
  log?: (line: string) => void;
  mcpCompatibility?: McpCompatibilityOptions;
  // The Control Plane outbox; by default the node config directory's
  // (KHEREP_CONFIG_DIR or the per-OS location) control-plane/outbox.
  controlPlaneOutbox?: string;
  // Disabled by default. Enables the local rotating-credential messaging MCP client projection.
  messagingClient?: boolean;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "");
}

function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function resolveWorkspace(options: InstallOptions = {}, platform: string = process.platform): string {
  const configured = options.workspace ?? productEnv(process.env, "WORKSPACE");
  if (configured !== undefined) {
    if (configured === "") throw new Error("KHEREP_WORKSPACE must not be empty");
    return path.resolve(nativeWorkspacePath(configured, platform));
  }
  const homeDir = options.homeDir || os.homedir();
  return path.resolve(path.join(homeDir, "Kherep"));
}

function declaredMissing(capabilities: Capabilities): string[] {
  return Object.entries(capabilities)
    .filter(([, entry]) => entry && typeof entry === "object" && ["missing", "unverified"].includes(String((entry as { status?: unknown }).status)))
    .map(([name]) => name);
}

function resolvedCodexHome(options: InstallOptions): string {
  return path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function previousModelResolution(codexHome: string): unknown {
  let text: string;
  try { text = fs.readFileSync(path.join(codexHome, "orchestra", "parity-receipt.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Installed model receipt is unreadable");
  }
  try {
    const receipt: unknown = JSON.parse(text);
    if (record(receipt)) return receipt.modelResolution;
  } catch { /* A corrupt read must not look like a fresh installation. */ }
  throw new Error("Installed model receipt is unreadable");
}

export type ModelCatalogReader = (options: { codexHome: string }) => Promise<unknown>;

// The async entry point collects metadata before the synchronous transaction.
// A normal reinstall validates and reuses its canonical receipt without a read.
export async function installFromCli(options: InstallOptions, readCatalog: ModelCatalogReader = readAvailableModels) {
  const codexHome = resolvedCodexHome(options);
  const existing = previousModelResolution(codexHome);
  let modelCatalog = options.modelCatalog;
  if (options.refreshModels === true || existing === undefined) {
    if (modelCatalog === undefined) {
      // Codex refuses a CODEX_HOME that does not exist (measured 0.160.1). A home named by the caller
      // is created here, private, before the read; the transaction would create it moments later
      // anyway. A home taken from CODEX_HOME or the default is left as it is.
      if (options.codexHome && !fs.existsSync(codexHome)) fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      try { modelCatalog = await readCatalog({ codexHome }); }
      catch (error) { throw error instanceof CatalogReadError ? error : new CatalogReadError(); }
    }
  }
  return install({ ...options, codexHome, modelCatalog });
}

// Issue #507, part 4 (lead decision 8). Codex skips a changed hook definition until it is
// trusted in /hooks; a previous block that ran the three guards directly loses them until then.
// Issue #538: the same for the messaging intent entry when the previous block ran it directly.
function trustReviewLine(previous: string, node: string, hookDir: string,
  messaging: { enabled: boolean; intentHook: string; configRoot: string }): string {
  const lines = previous.split(/\r?\n/);
  const ran = (direct: string): boolean => lines.includes(`command = ${JSON.stringify(direct)}`);
  const changed = [
    ...([atlassianDestructiveGuard(node, hookDir).command, command(node, path.join(hookDir, "codex-dispatch-contract-guard.mts")),
      command(node, path.join(hookDir, "playwright-file-guard.mts"))].some(ran)
      ? ["atlassian-destructive-guard", "codex-dispatch-contract-guard", "playwright-file-guard"] : []),
    ...(ran(command(node, path.join(path.dirname(hookDir), "kherep-maestro-context.mts")))
      ? ["SessionStart context", "UserPromptSubmit context"] : []),
    ...(messaging.enabled && ran(command(node, messaging.intentHook, "--config-root", messaging.configRoot)) ? ["messaging intent"] : []),
  ];
  const head = "config.toml: the managed hook block was replaced; Codex skips a changed hook definition until it is reviewed and trusted in /hooks";
  if (!changed.length) return head;
  const named = changed.length > 1 ? `${changed.slice(0, -1).join(", ")} and ${changed.at(-1)} entries, which do not`
    : `${changed[0]} entry, which does not`;
  return `${head} (this upgrade changes the ${named} run until then)`;
}

export function install(options: InstallOptions = {}) {
  const sourceRoot = import.meta.dirname;
  const repoRoot = path.resolve(sourceRoot, "..");
  assertResearchHookParity(repoRoot);
  const platform = options.platform || process.platform;
  const codexHome = resolvedCodexHome(options);
  const capabilitiesFile = path.join(sourceRoot, "parity", "capabilities.json");
  const modelPolicyFile = path.join(sourceRoot, "parity", "model-policy.toml");
  const modelResolution = selectModelResolution(fs.readFileSync(modelPolicyFile, "utf8"), {
    existing: previousModelResolution(codexHome), catalog: options.modelCatalog, refresh: options.refreshModels,
  });
  const capabilities = resolveCapabilities(JSON.parse(fs.readFileSync(capabilitiesFile, "utf8")) as Capabilities, modelResolution);
  const selectionFile = memoryProviderFile(codexHome);
  if (options.memoryProviderConfig && options.memoryProvider !== undefined) throw new Error("Memory provider selection is ambiguous");
  const { memoryProvider, retired: retiredMemoryProvider } = resolveMemoryProvider(selectionFile, options.memoryProviderConfig
    ? JSON.parse(fs.readFileSync(options.memoryProviderConfig, "utf8")) : options.memoryProvider);
  const workspace = resolveWorkspace(options, platform);
  const claudeHome = path.resolve(options.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  // #44. Workspace files retired through the one declaration both installers
  // read. Parsed before anything is written, so an invalid manifest moves nothing.
  const retiredWorkspace = readRetiredWorkspaceEntries(
    options.retiredManifest || path.join(repoRoot, "bootstrap", "manifest", "retired.txt"),
  );
  const registryFile = resolveRegistryFile({
    ...options,
    requiredMcpServers: capabilities.mcpServers,
  });
  const localMarketplace = path.join(sourceRoot, "marketplace");
  const sources = {
    agents: path.join(sourceRoot, "AGENTS.maestro.md"),
    userAgents: path.join(sourceRoot, "AGENTS.user.md"),
    routing: path.join(sourceRoot, "ROUTING.md"),
    contextHook: path.join(sourceRoot, "hooks", "kherep-maestro-context.mts"),
    claudeHooks: path.join(repoRoot, "claude", "hooks"),
    cbmHook: path.join(sourceRoot, "hooks", "cbm-reminder.mts"),
    dispatchHook: path.join(sourceRoot, "hooks", "dispatch-contract-guard.mts"),
    precompactHook: path.join(sourceRoot, "hooks", "precompact-checkpoint.mts"),
    acceptanceHook: path.join(sourceRoot, "hooks", "acceptance-gate.mts"),
    acceptancePolicy: path.join(sourceRoot, "hooks", "acceptance-policy.mts"),
    observationStopHook: path.join(sourceRoot, "hooks", "observation-stop.mts"),
    observationHook: path.join(sourceRoot, "hooks", "observation-turn-completion.mts"),
    hookAdapter: path.join(sourceRoot, "hooks", "hook-adapter.mts"),
    hookAdapterPayload: path.join(sourceRoot, "hooks", "hook-adapter-payload.mts"),
    hookAdapterVerdict: path.join(sourceRoot, "hooks", "hook-adapter-verdict.mts"),
    hookAdapterRun: path.join(sourceRoot, "hooks", "hook-adapter-run.mts"),
    postEditDispatcher: path.join(sourceRoot, "hooks", "post-edit-checks.mts"),
    shellDispatcher: path.join(sourceRoot, "hooks", "shell-checks.mts"),
    controlPlaneEntry: path.join(sourceRoot, "hooks", "control-plane-hook.mts"),
    postEditToolCalls: path.join(sourceRoot, "hooks", "post-edit-tool-calls.mts"),
    privacyHook: path.join(sourceRoot, "hooks", "privacy-boundary-guard.mts"),
    confluenceDeliveryHook: path.join(sourceRoot, "hooks", "confluence-delivery-check.mts"),
    integrityHook: path.join(sourceRoot, "hooks", "hook-integrity.mts"),
    integrityRepair: path.join(sourceRoot, "hooks", "hook-integrity-repair.mts"),
    integritySources: path.join(sourceRoot, "hooks", "hook-integrity-sources.mts"),
    controlPlane: path.join(repoRoot, "modules", "control-plane"),
    researchFirstHook: path.join(sourceRoot, "hooks", "research-first.mts"),
    researchStopHook: path.join(sourceRoot, "hooks", "research-stop.mts"),
    researchCommon: path.join(sourceRoot, "hooks", "research-common.mts"),
    researchExecParser: path.join(sourceRoot, "hooks", "research-exec-parser.mts"),
    researchTranscript: path.join(sourceRoot, "hooks", "research-transcript.mts"),
    obsResultHook: path.join(sourceRoot, "hooks", "obs-result-check.mts"),
    obsCandidatePolicy: path.join(repoRoot, "modules", "atl-jira-brokers", "observation-candidate.mts"),
    obsResultPolicy: path.join(repoRoot, "modules", "atl-jira-brokers", "observation-result.mts"),
    registryBridge: path.join(repoRoot, "modules", "mcp-auth-bridge", "registry-http-wrapper.mts"),
    registryRuntime: path.join(repoRoot, "modules", "mcp-auth-bridge", "supergateway-secret-wrapper.mts"),
    localInferenceRunner: path.join(repoRoot, "modules", "local-inference", "runner.mts"),
    localInferenceLib: path.join(repoRoot, "modules", "local-inference", "lib"),
    localInferenceConfig: path.join(repoRoot, "bootstrap", "manifest", "local-inference.json"),
    twg: path.join(repoRoot, "modules", "twg", "runtime"),
    atlassianCredentials: path.join(repoRoot, "modules", "atl-jira-brokers", "atlassian-credentials.mts"),
    atlassianCliArgs: path.join(repoRoot, "modules", "atl-jira-brokers", "atlassian-cli-args.mts"),
    jiraAdfRenderer: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-adf.mts"),
    jiraAdfReader: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-adf-text.mts"),
    jiraAttach: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-attach.mts"),
    jiraDownload: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-download.mts"),
    jiraConfig: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-config.mts"),
    jiraFields: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-fields.mts"),
    jiraLinks: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-links.mts"),
    jiraSearch: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-search.mts"),
    jiraDiscovery: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-discovery.mts"),
    jiraTransitionGuard: path.join(repoRoot, "modules", "atl-jira-brokers", "jira-transition-guard.mts"),
    codexJiraBroker: path.join(repoRoot, "modules", "atl-jira-brokers", "atl-jira.mts"),
    claudeJiraBroker: path.join(repoRoot, "modules", "atl-jira-brokers", "atl-jira-ccoder.mts"),
    // OP-1405. The Confluence broker is versioned in the Jira broker directory
    // because this projection is FLAT: every relative import has to resolve
    // inside <workspace>/tools/.
    confluenceContract: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-contract.mts"),
    confluenceContent: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-content.mts"),
    confluenceSession: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-session.mts"),
    confluenceRelated: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-related.mts"),
    confluenceTextSearch: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-text-search.mts"),
    confluenceSemantic: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-semantic.mts"),
    confluenceNeighbours: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-neighbours.mts"),
    confluenceNeighbourCli: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-neighbour-cli.mts"),
    confluenceTopicQuery: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-topic-query.mts"),
    confluenceCandidates: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-candidates.mts"),
    confluenceStitch: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-stitch.mts"),
    confluenceListCli: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-list-cli.mts"),
    confluenceRuntimeLabel: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-runtime-label.mts"),
    confluenceLabelCli: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-label-cli.mts"),
    confluencePagination: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-pagination.mts"),
    confluenceDrainageRules: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-drainage-rules.mts"),
    confluenceDrainageSnapshot: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-drainage-snapshot.mts"),
    confluenceDrainageScan: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-drainage-scan.mts"),
    confluenceDrainageCli: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-drainage-cli.mts"),
    confluenceEvidence: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-evidence.mts"),
    confluenceEvidenceReport: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-evidence-report.mts"),
    confluenceEvidenceIo: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-evidence-io.mts"),
    confluenceEvidenceCli: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-evidence-cli.mts"),
    confluenceClaimText: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-claim-text.mts"),
    confluenceObservationValidate: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-observation-validate.mts"),
    confluenceRevisionStaleness: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-revision-staleness.mts"),
    confluenceRevisionStalenessGit: path.join(repoRoot, "modules", "atl-jira-brokers", "confluence-revision-staleness-git.mts"),
    codexConfluenceBroker: path.join(repoRoot, "modules", "atl-jira-brokers", "atl-confluence.mts"),
    claudeConfluenceBroker: path.join(repoRoot, "modules", "atl-jira-brokers", "atl-confluence-ccoder.mts"),
  };
  const contextHook = path.join(codexHome, "hooks", "kherep-maestro-context.mts");
  const registryBridge = path.join(codexHome, "orchestra", "registry-http-bridge.mts");
  const registryRuntime = path.join(codexHome, "orchestra", "supergateway-secret-wrapper.mts");
  const targets = {
    agents: path.join(codexHome, "AGENTS.md"),
    config: path.join(codexHome, "config.toml"),
    routing: path.join(codexHome, "orchestra", "ROUTING.md"),
    receipt: path.join(codexHome, "orchestra", "parity-receipt.json"),
    contextHook,
    hookDir: path.join(codexHome, "hooks", "kherep-maestro"),
    registryBridge,
    registryRuntime,
    localInference: path.join(codexHome, "kherep", "local-inference"),
    twg: path.join(codexHome, "kherep", "twg"),
    memoryNotifyHook: path.join(codexHome, "hooks", "kherep-maestro", "codex-memory-notify.js"),
    atlassianCredentials: path.join(workspace, "tools", "atlassian-credentials.mts"),
    atlassianCliArgs: path.join(workspace, "tools", "atlassian-cli-args.mts"),
    jiraAdfRenderer: path.join(workspace, "tools", "jira-adf.mts"),
    jiraAdfReader: path.join(workspace, "tools", "jira-adf-text.mts"),
    jiraAttach: path.join(workspace, "tools", "jira-attach.mts"),
    jiraDownload: path.join(workspace, "tools", "jira-download.mts"),
    jiraConfig: path.join(workspace, "tools", "jira-config.mts"),
    jiraFields: path.join(workspace, "tools", "jira-fields.mts"),
    jiraLinks: path.join(workspace, "tools", "jira-links.mts"),
    jiraSearch: path.join(workspace, "tools", "jira-search.mts"),
    jiraDiscovery: path.join(workspace, "tools", "jira-discovery.mts"),
    jiraTransitionGuard: path.join(workspace, "tools", "jira-transition-guard.mts"),
    codexJiraBroker: path.join(workspace, "tools", "atl-jira.mts"),
    claudeJiraBroker: path.join(workspace, "tools", "atl-jira-ccoder.mts"),
    confluenceContract: path.join(workspace, "tools", "confluence-contract.mts"),
    confluenceContent: path.join(workspace, "tools", "confluence-content.mts"),
    confluenceSession: path.join(workspace, "tools", "confluence-session.mts"),
    confluenceRelated: path.join(workspace, "tools", "confluence-related.mts"),
    confluenceTextSearch: path.join(workspace, "tools", "confluence-text-search.mts"),
    confluenceSemantic: path.join(workspace, "tools", "confluence-semantic.mts"),
    confluenceNeighbours: path.join(workspace, "tools", "confluence-neighbours.mts"),
    confluenceNeighbourCli: path.join(workspace, "tools", "confluence-neighbour-cli.mts"),
    confluenceTopicQuery: path.join(workspace, "tools", "confluence-topic-query.mts"),
    confluenceCandidates: path.join(workspace, "tools", "confluence-candidates.mts"),
    confluenceStitch: path.join(workspace, "tools", "confluence-stitch.mts"),
    confluenceListCli: path.join(workspace, "tools", "confluence-list-cli.mts"),
    confluenceRuntimeLabel: path.join(workspace, "tools", "confluence-runtime-label.mts"),
    confluenceLabelCli: path.join(workspace, "tools", "confluence-label-cli.mts"),
    confluencePagination: path.join(workspace, "tools", "confluence-pagination.mts"),
    confluenceDrainageRules: path.join(workspace, "tools", "confluence-drainage-rules.mts"),
    confluenceDrainageSnapshot: path.join(workspace, "tools", "confluence-drainage-snapshot.mts"),
    confluenceDrainageScan: path.join(workspace, "tools", "confluence-drainage-scan.mts"),
    confluenceDrainageCli: path.join(workspace, "tools", "confluence-drainage-cli.mts"),
    confluenceEvidence: path.join(workspace, "tools", "confluence-evidence.mts"),
    confluenceEvidenceReport: path.join(workspace, "tools", "confluence-evidence-report.mts"),
    confluenceEvidenceIo: path.join(workspace, "tools", "confluence-evidence-io.mts"),
    confluenceEvidenceCli: path.join(workspace, "tools", "confluence-evidence-cli.mts"),
    confluenceClaimText: path.join(workspace, "tools", "confluence-claim-text.mts"),
    confluenceObservationValidate: path.join(workspace, "tools", "confluence-observation-validate.mts"),
    confluenceRevisionStaleness: path.join(workspace, "tools", "confluence-revision-staleness.mts"),
    confluenceRevisionStalenessGit: path.join(workspace, "tools", "confluence-revision-staleness-git.mts"),
    codexConfluenceBroker: path.join(workspace, "tools", "atl-confluence.mts"),
    claudeConfluenceBroker: path.join(workspace, "tools", "atl-confluence-ccoder.mts"),
    hook: contextHook,
    messagingClient: path.join(codexHome, "orchestra", "control-plane"),
  };
  const mcp = managedConfig.resolveRegistry({
    ...options,
    claudeRegistryFile: registryFile,
    registryBridge: targets.registryBridge,
  });
  let registryProjections = projectRegistry(mcp.registry, capabilities.mcpServers, {
    sourceNames: options.mcpCompatibility?.sourceNames,
    legacyRegistryAdapters: options.mcpCompatibility?.legacyEnvPrefixes?.map((envPrefix) => ({
      node: mcp.node, bridge: targets.registryBridge, envPrefix,
    })),
  });
  for (const [name, binding] of Object.entries(options.mcpCompatibility?.operatorBindings || {})) {
    const projected = projectOperatorBinding(name, binding, {
      node: mcp.node,
      runtime: targets.registryRuntime,
    });
    registryProjections = registryProjections.map((entry) => entry.name === name ? projected : entry);
  }
  (options.resolveRegistryRuntime || registryBridgeModule.resolveRuntime)();
  const existingConfig = fs.existsSync(targets.config) ? fs.readFileSync(targets.config, "utf8") : "";
  const existingPlugin = localPlugin.ownedPluginConfig(existingConfig);
  const retiredMcpServerNames = [...new Set([
    ...RETIRED_MCP_SERVERS,
    ...(capabilities.retiredMcpServers || []),
  ])];
  const basePluginMcpServers = capabilities.pluginMcpServers || {};
  // Issue #397. An upgrade keeps the optional Atlassian tool set an earlier
  // install configured; only an explicit opt-out (any value but 1) drops it.
  const markers = { start: CONFIG_START, end: CONFIG_END };
  const installedAtlassian = hasManagedAtlassianTable(existingConfig, markers);
  const previousAtlassianToken = managedAtlassianTokenFile(existingConfig, markers);
  const atlassianSwitch = process.env.KHEREP_INSTALL_ATLASSIAN_TOOLS;
  const installAtlassianTools = options.installAtlassianTools
    ?? (atlassianSwitch ? atlassianSwitch === "1" : installedAtlassian);
  // Issue #376. The Atlassian server runs as the Codex service account or not
  // at all: without a usable key file nothing falls back to a personal login.
  const atlassianTable = { node: mcp.node, runtime: targets.registryRuntime };
  const atlassianToken = installAtlassianTools
    ? resolveTokenBinding("codex", { claude: claudeHome, codex: codexHome }, process.env,
      options.atlassianMcpTokenFile, previousAtlassianToken)
    : undefined;
  // Issue #397. A service-account table the block carries is never dropped for
  // want of a usable key file; the install stops before it writes anything.
  if (previousAtlassianToken && atlassianToken && atlassianToken.status !== "ok") {
    throw new Error(`Refusing to remove the managed mcp_servers.atlassian table: ${tokenBindingProblem(atlassianToken)}.`
      + " Make the key file usable, or set KHEREP_INSTALL_ATLASSIAN_TOOLS=0 to remove the table.");
  }
  const optionalPluginMcpServers: Record<string, PluginMcpServer> = atlassianToken?.status === "ok"
    ? { [ATLASSIAN_MCP_SERVER]: atlassianMcpServer(atlassianToken.file, atlassianTable) } : {};
  const predecessorOptionalPluginMcpServers = [
    { [ATLASSIAN_MCP_SERVER]: PREDECESSOR_NATIVE_ATLASSIAN },
    ...(previousAtlassianToken
      ? [{ [ATLASSIAN_MCP_SERVER]: atlassianMcpServer(previousAtlassianToken, atlassianTable) }] : []),
  ];
  const controlPlaneOutboxPath = path.resolve(options.controlPlaneOutbox || controlPlaneOutbox(process.env, platform));
  const messagingClient = {
    enabled: options.messagingClient === true,
    bridge: path.join(targets.messagingClient, "node", "mcp-stdio-bridge.mts"),
    intentHook: path.join(targets.messagingClient, "node", "mcp-intent-hook.mts"),
    configRoot: path.dirname(path.dirname(controlPlaneOutboxPath)),
  };
  // Issue #436. The intercom command of that config root, for the AGENTS.md
  // block, ROUTING.md and the rules; an unquotable root stops here, before any write.
  const intercom = intercomValues(messagingClient.configRoot);
  const managedConfigOptions = {
    observationPublisher: { entry: path.join(workspace, "tools", "observation-stdio.mts"), home: codexHome },
    memoryProvider: memoryProvider.provider,
    // OP-1429. A block an older installer wrote for the retired Central Brain is
    // recognised as managed and replaced; the selection file goes to the backup.
    retiredCentralBrain: retiredMemoryProvider?.binding
      ? retiredCentralBrainRender(retiredMemoryProvider.binding, mcp.node) : undefined,
    startMarker: CONFIG_START,
    endMarker: CONFIG_END,
    retiredMcpServerNames,
    registryProjections,
    pluginMcpServers: { ...optionalPluginMcpServers, ...basePluginMcpServers },
    optionalPluginMcpServers,
    predecessorOptionalPluginMcpServers,
    contextHook: targets.contextHook,
    contextWorkspace: workspace,
    hookDir: targets.hookDir,
    node: mcp.node,
    registry: mcp.registry,
    registryBridge: targets.registryBridge,
    registryRuntime: targets.registryRuntime,
    memoryNotifyHook: targets.memoryNotifyHook,
    mcpCompatibility: options.mcpCompatibility,
    controlPlaneHook: path.join(repoRoot, "modules", "control-plane", "node", "deliver-hook.mts"),
    controlPlaneOutbox: controlPlaneOutboxPath,
    messagingClient,
  };
  prepareManagedConfig(existingPlugin.config, managedConfigOptions);

  let backupRoot = path.join(codexHome, "backups", "kherep", timestamp());
  if (fs.existsSync(backupRoot)) backupRoot = `${backupRoot}-${process.pid}`;
  let writes = 0;
  function recordWrite(): void {
    writes += 1;
    options.afterWrite?.(writes);
  }
  const transaction = new InstallTransaction(codexHome, backupRoot, recordWrite);
  const workspaceTransaction = new InstallTransaction(
    workspace,
    path.join(backupRoot, "workspace"),
    recordWrite,
  );

  try {
    transaction.stage(targets.config);
    transaction.writeFile(selectionFile, `${JSON.stringify(memoryProvider, null, 2)}\n`);
    if (existingPlugin.config !== existingConfig) transaction.writeFile(targets.config, existingPlugin.config);
    if (!options.skipPluginRegistration) {
      localPlugin.registerLocalPlugin(localMarketplace, LOCAL_PLUGIN_ID, { ...options, codexHome });
    }

    for (const [source, target] of [
      [sources.atlassianCredentials, targets.atlassianCredentials],
      [sources.atlassianCliArgs, targets.atlassianCliArgs],
      [sources.confluenceContract, targets.confluenceContract],
      [sources.confluenceContent, targets.confluenceContent],
      [sources.confluenceSession, targets.confluenceSession],
      [sources.confluenceRelated, targets.confluenceRelated],
      [sources.confluenceTextSearch, targets.confluenceTextSearch],
      [sources.confluenceSemantic, targets.confluenceSemantic],
      [sources.confluenceNeighbours, targets.confluenceNeighbours],
      [sources.confluenceNeighbourCli, targets.confluenceNeighbourCli],
      [sources.confluenceTopicQuery, targets.confluenceTopicQuery],
      [sources.confluenceCandidates, targets.confluenceCandidates],
      [sources.confluenceStitch, targets.confluenceStitch],
      [sources.confluenceListCli, targets.confluenceListCli],
      [sources.confluenceRuntimeLabel, targets.confluenceRuntimeLabel],
      [sources.confluenceLabelCli, targets.confluenceLabelCli],
      [sources.confluencePagination, targets.confluencePagination],
      [sources.confluenceDrainageRules, targets.confluenceDrainageRules],
      [sources.confluenceDrainageSnapshot, targets.confluenceDrainageSnapshot],
      [sources.confluenceDrainageScan, targets.confluenceDrainageScan],
      [sources.confluenceDrainageCli, targets.confluenceDrainageCli],
      [sources.confluenceEvidence, targets.confluenceEvidence],
      [sources.confluenceEvidenceReport, targets.confluenceEvidenceReport],
      [sources.confluenceEvidenceIo, targets.confluenceEvidenceIo],
      [sources.confluenceEvidenceCli, targets.confluenceEvidenceCli],
      [sources.confluenceClaimText, targets.confluenceClaimText],
      [sources.confluenceObservationValidate, targets.confluenceObservationValidate],
      [sources.confluenceRevisionStaleness, targets.confluenceRevisionStaleness],
      [sources.confluenceRevisionStalenessGit, targets.confluenceRevisionStalenessGit],
      [sources.codexConfluenceBroker, targets.codexConfluenceBroker],
    ] as const) workspaceTransaction.copyFile(source, target);

    copyObservationBroker(repoRoot, workspace, workspaceTransaction);
    copyGithubBroker(repoRoot, workspace, workspaceTransaction);

    if (installAtlassianTools) {
      workspaceTransaction.copyFile(sources.jiraAdfRenderer, targets.jiraAdfRenderer);
      workspaceTransaction.copyFile(sources.jiraAdfReader, targets.jiraAdfReader);
      workspaceTransaction.copyFile(sources.jiraAttach, targets.jiraAttach);
      workspaceTransaction.copyFile(sources.jiraDownload, targets.jiraDownload);
      workspaceTransaction.copyFile(sources.jiraConfig, targets.jiraConfig);
      workspaceTransaction.copyFile(sources.jiraFields, targets.jiraFields);
      workspaceTransaction.copyFile(sources.jiraLinks, targets.jiraLinks);
      workspaceTransaction.copyFile(sources.jiraSearch, targets.jiraSearch);
      workspaceTransaction.copyFile(sources.jiraDiscovery, targets.jiraDiscovery);
      workspaceTransaction.copyFile(sources.jiraTransitionGuard, targets.jiraTransitionGuard);
      workspaceTransaction.copyFile(sources.codexJiraBroker, targets.codexJiraBroker);
      workspaceTransaction.copyFile(sources.claudeJiraBroker, targets.claudeJiraBroker);
      workspaceTransaction.copyFile(sources.claudeConfluenceBroker, targets.claudeConfluenceBroker);
    }
    // Parked with a backup, never deleted, and independent of the optional Jira
    // tooling: a file retired by the manifest is retired on every install.
    retireWorkspaceEntries(retiredWorkspace, workspace, workspaceTransaction,
      options.log || ((line) => process.stdout.write(`${line}\n`)));

    transaction.copyFile(sources.contextHook, targets.contextHook);
    transaction.copyFile(path.join(sourceRoot, "lib", "memory-provider.mts"), path.join(codexHome, "lib", "memory-provider.mts"));
    transaction.writeFile(targets.routing, renderIntercom(fs.readFileSync(sources.routing, "utf8"), intercom));
    transaction.copyFile(sources.registryBridge, targets.registryBridge);
    transaction.copyFile(sources.registryRuntime, targets.registryRuntime);
    transaction.copyFile(sources.localInferenceRunner, path.join(targets.localInference, "runner.mts"));
    transaction.installDir(sources.localInferenceLib, path.join(targets.localInference, "lib"));
    const localInferenceTarget = path.join(targets.localInference, "config.json");
    const sourceInference = JSON.parse(fs.readFileSync(sources.localInferenceConfig, "utf8"));
    const existingInference = fs.existsSync(localInferenceTarget)
      ? JSON.parse(fs.readFileSync(localInferenceTarget, "utf8")) : {};
    const renderedInference = mergeLocalInferenceConfig(
      platform === "darwin" ? "mac" : "win", sourceInference, existingInference,
    );
    transaction.writeFile(localInferenceTarget, `${JSON.stringify(renderedInference, null, 2)}\n`);
    transaction.installDir(sources.twg, targets.twg);
    transaction.installDir(path.join(sources.claudeHooks, "lib"), path.join(targets.hookDir, "lib"));
    for (const name of SHARED_HOOKS) {
      transaction.copyFile(path.join(sources.claudeHooks, name), path.join(targets.hookDir, name));
    }
    transaction.copyFile(sources.cbmHook, path.join(targets.hookDir, "codex-cbm-reminder.mts"));
    transaction.copyFile(sources.dispatchHook, path.join(targets.hookDir, "codex-dispatch-contract-guard.mts"));
    transaction.copyFile(sources.precompactHook, path.join(targets.hookDir, "codex-precompact-checkpoint.mts"));
    transaction.copyFile(sources.acceptancePolicy, path.join(targets.hookDir, "acceptance-policy.mts"));
    transaction.copyFile(sources.acceptanceHook, path.join(targets.hookDir, "codex-acceptance-gate.mts"));
    transaction.writeFile(
      path.join(targets.hookDir, "codex-observation-stop.mts"),
      renderObservationHook(fs.readFileSync(sources.observationStopHook, "utf8"), workspace),
    );
    transaction.writeFile(
      path.join(targets.hookDir, "codex-observation-turn-completion.mts"),
      renderObservationHook(fs.readFileSync(sources.observationHook, "utf8"), workspace),
    );
    transaction.copyFile(sources.hookAdapter, path.join(targets.hookDir, "codex-hook-adapter.mts"));
    transaction.copyFile(sources.hookAdapter, path.join(targets.hookDir, "hook-adapter.mts"));
    transaction.copyFile(sources.hookAdapterPayload, path.join(targets.hookDir, "hook-adapter-payload.mts"));
    transaction.copyFile(sources.hookAdapterVerdict, path.join(targets.hookDir, "hook-adapter-verdict.mts"));
    transaction.copyFile(sources.hookAdapterRun, path.join(targets.hookDir, "hook-adapter-run.mts"));
    transaction.copyFile(sources.postEditDispatcher, path.join(targets.hookDir, "codex-post-edit-checks.mts"));
    transaction.copyFile(sources.shellDispatcher, path.join(targets.hookDir, "codex-shell-checks.mts"));
    // Issue #504: the denied-call renderer, an operator CLI beside the installed lib/, never a hook.
    transaction.copyFile(path.join(sources.claudeHooks, "denied-calls.mts"), path.join(targets.hookDir, "denied-calls.mts"));
    // Issue #503. Every Control Plane hook command names this entry point, which
    // runs the hooks of the source the pointer names: this installer's root.
    transaction.copyFile(sources.controlPlaneEntry, path.join(targets.hookDir, "codex-control-plane-hook.mts"));
    transaction.writeFile(pointerFile(codexHome), renderControlPlanePointer(repoRoot));
    transaction.copyFile(sources.postEditToolCalls, path.join(targets.hookDir, "post-edit-tool-calls.mts"));
    transaction.copyFile(sources.privacyHook, path.join(targets.hookDir, "codex-privacy-boundary-guard.mts"));
    transaction.copyFile(sources.confluenceDeliveryHook, path.join(targets.hookDir, "codex-confluence-delivery-check.mts"));
    // Issue #275. Its libs are the claude/hooks/lib copy installed above.
    transaction.copyFile(sources.integrityHook, path.join(targets.hookDir, "codex-hook-integrity.mts"));
    transaction.copyFile(sources.integrityRepair, path.join(targets.hookDir, "hook-integrity-repair.mts"));
    transaction.copyFile(sources.integritySources, path.join(targets.hookDir, "hook-integrity-sources.mts"));
    if (messagingClient.enabled) {
      for (const relative of [
        "protocol.mts", "protocol-mcp.mts", "protocol-messages.mts", "protocol-loop-brake.mts", "protocol-session-identity.mts", "protocol-message-binding.mts", "protocol-task-control.mts", "protocol-tasks.mts",
        path.join("node", "config.mts"), path.join("node", "inbox.mts"), path.join("node", "inbox-storage.mts"), path.join("node", "inbox-selected-read.mts"), path.join("node", "inbox-record-lock.mts"), path.join("node", "mcp-local.mts"),
        path.join("node", "mcp-credential-file.mts"),
        path.join("node", "guarded-replies.mts"), path.join("node", "message-owner.mts"),
        path.join("node", "session-publication.mts"),
        path.join("node", "policy.mts"), path.join("node", "session-policy.mts"),
        path.join("node", "mcp-intent-hook.mts"), path.join("node", "mcp-stdio-bridge.mts"),
      ]) transaction.copyFile(path.join(sources.controlPlane, relative), path.join(targets.messagingClient, relative));
    }
    transaction.copyFile(sources.researchFirstHook, path.join(targets.hookDir, "codex-research-first.mts"));
    transaction.copyFile(sources.researchStopHook, path.join(targets.hookDir, "codex-research-stop.mts"));
    transaction.copyFile(sources.researchCommon, path.join(targets.hookDir, "research-common.mts"));
    transaction.copyFile(sources.researchExecParser, path.join(targets.hookDir, "research-exec-parser.mts"));
    transaction.copyFile(sources.researchTranscript, path.join(targets.hookDir, "research-transcript.mts"));
    // Issue #326, PR-B. It reads its rollout fallback through research-transcript.mts.
    transaction.copyFile(sources.obsResultHook, path.join(targets.hookDir, "codex-obs-result-check.mts"));
    transaction.copyFile(sources.obsCandidatePolicy, path.join(targets.hookDir, "obs-candidate-policy.mts"));
    transaction.copyFile(sources.obsResultPolicy, path.join(targets.hookDir, "obs-result-policy.mts"));
    copyObservationSnapshot(repoRoot, codexHome, transaction);
    transaction.remove(targets.memoryNotifyHook);
    // Issue #72. Beside the deliver hook: the msg CLI allowlist.
    // Issue #436. Only the stable launcher, which the task prompt, the delivery
    // hook and the instructions name; the whole file is rewritten, so the
    // checkout CLI rule of an older install goes.
    transaction.writeFile(controlPlaneRulesPath(codexHome), renderControlPlaneRules([launcherRule(intercom.command)]));
    for (const relative of RETIRED_TARGETS) transaction.remove(path.join(codexHome, relative));

    const projection = parityProjection.project({
      memoryProvider: memoryProvider.provider,
      capabilities,
      claudeHome,
      codexHome,
      repoRoot,
      transaction,
    });
    // Projection determines the actual plugin names, including personal-name
    // collisions. Write the guard snapshot only after those native TOMLs exist.
    transaction.writeFile(path.join(targets.hookDir, "..", "parity", "capabilities.json"),
      `${JSON.stringify({ ...capabilities, projectedAgents: projection.agentDefaults }, null, 2)}\n`);
    transaction.copyFile(modelPolicyFile, path.join(codexHome, "orchestra", "model-policy.toml"));

    const existingAgents = fs.existsSync(targets.agents) ? fs.readFileSync(targets.agents, "utf8") : "";
    let agents = setMarkedBlock(existingAgents, AGENTS_START, AGENTS_END,
      renderIntercom(fs.readFileSync(sources.agents, "utf8"), intercom));
    agents = setMarkedBlock(agents, USER_START, USER_END, fs.readFileSync(sources.userAgents, "utf8"));
    transaction.writeFile(targets.agents, agents);

    const latestConfig = fs.existsSync(targets.config) ? fs.readFileSync(targets.config, "utf8") : "";
    const latestPlugin = localPlugin.ownedPluginConfig(latestConfig);
    const preparedConfig = prepareManagedConfig(latestPlugin.config, managedConfigOptions);
    if (preparedConfig.managedFragment === "replaced") {
      (options.log || ((line) => process.stdout.write(`${line}\n`)))(trustReviewLine(latestPlugin.config, mcp.node, targets.hookDir, messagingClient));
    }
    const {
      existingManagedMcp, pluginMcpServers, recoveredMcpServers,
      repairedMcpServers, retiredMcpServers,
    } = preparedConfig;
    let config = preparedConfig.config;
    config = setPluginEnabled(config, LOCAL_PLUGIN_ID, existingPlugin.preferredEnabled);
    transaction.writeFile(targets.config, config);

    const receipt = {
      schemaVersion: 1,
      memoryProvider: memoryProvider.provider,
      ...(retiredMemoryProvider && { retiredMemoryProvider: retiredMemoryProvider.provider }),
      generatedAt: new Date().toISOString(),
      platform,
      manifestSha256: hashFile(capabilitiesFile),
      modelResolution,
      canonicalTargetPolicy: capabilities.canonicalTargetPolicy,
      claudeModified: false,
      hooks: ["PreToolUse", "UserPromptSubmit", "PostToolUse", "SessionStart", "PreCompact", "Stop", "SubagentStart", "SubagentStop"],
      mcpServers: registryProjections.map((projection) => {
        const { name, transport } = projection;
        if (recoveredMcpServers.has(name)) return { name, status: "preserved-existing" };
        if (transport === "legacy-registry-adapter") {
          return {
            name,
            status: "configured-source-repair-required",
            sourceTransport: "stdio",
            reason: "legacy-registry-adapter",
            ...(repairedMcpServers.includes(name) && { localConfigStatus: "repaired-preserved-existing" }),
          };
        }
        if (repairedMcpServers.includes(name)) {
          return existingManagedMcp.has(name)
            ? { name, status: "repaired-preserved-existing" }
            : { name, status: "repaired-known-legacy", transport };
        }
        if (existingManagedMcp.has(name)) return { name, status: "preserved-existing" };
        if (transport === "missing") return { name, status: "configured-source-missing" };
        if (transport === "unsupported-stdio") {
          return { name, status: "configured-source-unsupported", sourceTransport: "stdio" };
        }
        return { name, status: "configured", transport };
      }),
      pluginMcpServers: Object.keys(managedConfigOptions.pluginMcpServers).map((name) => ({
        name,
        status: Object.hasOwn(pluginMcpServers, name) ? "configured" : "preserved-existing",
      })),
      // Issue #376. Where the key file came from, never its path or content.
      atlassianMcp: atlassianToken ? {
        status: managedConfig.hasUnmanagedMcp(latestPlugin.config, ATLASSIAN_MCP_SERVER, CONFIG_START, CONFIG_END)
          ? "preserved-existing"
          : atlassianToken.status === "ok" ? "configured" : `skipped-token-file-${atlassianToken.status}`,
        authentication: "secret-file-bearer",
        tokenSource: atlassianToken.source,
      } : { status: installedAtlassian ? "removed" : "not-requested" },
      retiredMcpServers,
      // Issue #72: where the outbox writable root landed, or why it did not.
      controlPlaneOutbox: { status: preparedConfig.outboxWritableRoot },
      messagingClient: { status: messagingClient.enabled ? "configured" : "disabled" },
      // Issue #212: the top-level model_reasoning_effort the installer kept or set.
      reasoningEffort: preparedConfig.reasoningEffort,
      twg: {
        status: "installed",
        componentSha256: componentHash(sources.twg),
      },
      // The three literals are legacy entries without a manifest counterpart.
      // Everything else is DERIVED from capabilities.json: any entry declaring
      // status "missing" lands here automatically. Before OP-651 this list was
      // hardcoded, so a capability could be declared missing in the manifest
      // and still be absent from the receipt - a receipt that cannot report a
      // known gap is the same failure class the gap itself describes.
      degradedCapabilities: [...new Set([
        "plain-command-production-approval",
        ...declaredMissing(capabilities),
      ])],
      projection,
    };
    transaction.writeFile(targets.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
    const cacheRepair = { status: "not-requested" };
    return {
      backupRoot, codexHome, localMarketplace,
      cacheRepair, receipt, targets,
      atlassianMcpProblem: receipt.atlassianMcp.status.startsWith("skipped-") && atlassianToken
        ? tokenBindingProblem(atlassianToken) : undefined,
    };
  } catch (error) {
    transaction.rollback();
    workspaceTransaction.rollback();
    throw error;
  }
}

type CliOptions = Pick<InstallOptions,
  "codexHome" | "claudeConfigDir" | "registryFile" | "workspace" | "memoryProviderConfig"
  | "authorizeObservationPublishing" | "messagingClient" | "refreshModels">;

export function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const options: CliOptions = {};
  type ValueField = "codexHome" | "claudeConfigDir" | "registryFile" | "workspace" | "memoryProviderConfig";
  const fields = new Map<string, ValueField>([
    ["--codex-home", "codexHome"],
    ["--claude-config-dir", "claudeConfigDir"],
    ["--mcp-registry", "registryFile"],
    ["--workspace", "workspace"],
    ["--memory-provider-config", "memoryProviderConfig"],
  ]);
  while (args.length) {
    const flag = args.shift();
    if (flag === "--refresh-models") {
      options.refreshModels = true;
      continue;
    }
    if (flag === "--authorize-observation-publishing") {
      options.authorizeObservationPublishing = true;
      continue;
    }
    if (flag === "--enable-messaging-client") {
      options.messagingClient = true;
      continue;
    }
    const field = flag === undefined ? undefined : fields.get(flag);
    const value = field ? args.shift() : undefined;
    if (!field || value === undefined) throw new Error(`Unexpected or incomplete argument: ${flag}`);
    options[field] = value;
  }
  return options;
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
    const cliOptions = parseArgs(process.argv.slice(2));
    const result = await installFromCli(cliOptions);
    process.stdout.write([
      "Kherep Codex Maestro parity installed.",
      `Codex home: ${result.codexHome}`,
      `Backup: ${result.backupRoot}`,
      `Receipt: ${result.targets.receipt}`,
      "Restart Codex and run the kherep-maestro-parity skill in a fresh task.",
      "",
    ].join("\n"));
    if (result.atlassianMcpProblem) {
      process.stderr.write(`install: WARNING no Atlassian MCP server for Codex: ${result.atlassianMcpProblem}.`
        + " Nothing falls back to a personal login. The parity installation above stands.\n");
      process.exitCode = 1;
    } else if (result.receipt.atlassianMcp.status === "removed") {
      process.stderr.write("install: NOTE KHEREP_INSTALL_ATLASSIAN_TOOLS opts out, so the managed"
        + " mcp_servers.atlassian table and its key file binding were removed.\n");
    } else if (result.receipt.atlassianMcp.status === "preserved-existing") {
      process.stderr.write("install: NOTE mcp_servers.atlassian outside the Kherep block is the operator's own"
        + " and stays as it is; the Codex service-account server is not rendered.\n");
    }
    // Both per-host setup steps stay outside install(), which tests call without
    // a terminal. Resolve the Codex credential before reading the space and
    // placement nodes with that same service-account identity.
    const credentialOut = path.join(result.codexHome, "kherep", "atl-credential-codex.txt");
    const credential = spawnSync(process.execPath, [
      path.join(import.meta.dirname, "..", "bootstrap", "atl-credential.mts"),
      "--runtime", "codex",
      "--out", credentialOut,
    ], { stdio: "inherit" });
    if (credential.status !== 0) {
      process.stderr.write("install: WARNING no verified Atlassian service-account credential"
        + " - the Codex broker will not authenticate. The parity installation above stands.\n");
      process.exitCode = 1;
    }
    const spaceArgs = [
      path.join(import.meta.dirname, "..", "bootstrap", "confluence-space.mts"),
      "--out", path.join(result.codexHome, "kherep", "confluence.json"),
      "--runtime", "codex",
      "--existing", path.join(result.codexHome, "orchestra", "confluence.json"),
    ];
    if (cliOptions.authorizeObservationPublishing) spaceArgs.push("--authorize-observation-publishing");
    const credentialFile = resolveCredentialTarget(
      process.env, "KHEREP_ATL_CRED_FILE_CODEX", credentialOut,
    ).target;
    const space = spawnSync(process.execPath, spaceArgs, {
      stdio: "inherit",
      env: { ...process.env, KHEREP_ATL_CRED_FILE_CODEX: credentialFile },
    });
    if (space.status !== 0) {
      process.stderr.write("install: WARNING no Confluence knowledge space configured"
        + " - codex-obs will not write. The parity installation above stands.\n");
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
