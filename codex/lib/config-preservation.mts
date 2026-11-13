import path from "node:path";

import { hasExactExternalDeliverHooks, pointControlPlaneHooksAt } from "./control-plane-hook-path.mts";
import type { McpCompatibilityOptions, McpProjection, McpServerSpec, PluginMcpServer } from "./contracts.mts";
import * as managedConfig from "./managed-config.mts";
import { repairManagedMcp } from "./mcp-config-repair.mts";
import { recoverManagedMcpProjection } from "./mcp-operator-binding.mts";
import * as parityConfig from "./parity-config.mts";
import { preserveExternalPostToolPositions } from "./post-tool-trust-position.mts";
import { recognizeHistoricalManagedConfig } from "./historical-managed-artifacts.mts";
import { configureMemoryNotify } from "./memory-provider.mts";
import { reanchorSplitManagedBlock, UnknownManagedFragmentError } from "./managed-block-split.mts";
import { managedNodePaths, withManagedNodePaths } from "./node-path.mts";
import { managedOutboxRoots, projectOutboxWritableRoot } from "./outbox-writable-root.mts";
import { managedFragmentFamily, retiredCentralBrainFragments, retireUnmanagedCentralBrainTable } from "./retired-central-brain.mts";
import type { RetiredCentralBrainRender } from "./retired-central-brain.mts";
import { enableHooks, setMarkedBlock, setTopLevelSetting, topLevelSetting } from "./text-merge.mts";
import { hasTomlStringReference, rewriteExactTomlStringArgs } from "./toml-args.mts";

const MCP_TABLE_HEADER = /^[^\S\n\r\u2028\u2029]*\[\s*mcp_servers\s*\./m;
export interface ConfigUpgradeOptions {
  startMarker: string;
  endMarker: string;
  knownManagedFragments: string[];
  managedReplacement: string;
  mcpServerNames: string[];
  retiredBridge: string;
  currentBridge: string;
}

export interface ConfigUpgradeResult {
  config: string;
  managedFragment: "created" | "current" | "replaced";
  migratedMcpServers: string[];
}

export interface ManagedConfigOptions {
  observationPublisher?: import("./observation-projection.mts").ObservationProjection;
  memoryProvider?: "unconfigured";
  retiredCentralBrain?: RetiredCentralBrainRender;
  observationStopHook?: boolean;
  startMarker: string;
  endMarker: string;
  retiredMcpServerNames: string[];
  registryProjections: McpProjection[];
  pluginMcpServers: Record<string, PluginMcpServer>;
  // Plugin servers an install renders only on request. A block with or without
  // them is the installer's own; every older block lacks them.
  optionalPluginMcpServers?: Record<string, PluginMcpServer>;
  // Earlier renders of those optional servers (issue #376: the native OAuth
  // Atlassian table, or a service-account table for another token file). A
  // block carrying one of them is the installer's own as well.
  predecessorOptionalPluginMcpServers?: Record<string, PluginMcpServer>[];
  contextHook: string;
  contextWorkspace?: string;
  hookDir: string;
  node: string;
  registry: string;
  registryBridge: string;
  registryRuntime: string;
  memoryNotifyHook: string;
  mcpCompatibility?: McpCompatibilityOptions;
  controlPlaneHook?: string;
  // Issue #72. The Control Plane outbox, made a writable root of the sandbox.
  controlPlaneOutbox?: string;
  messagingClient?: parityConfig.MessagingClientRenderOptions;
}

interface PluginSet {
  plugins: Record<string, PluginMcpServer>;
  predecessorPlugins: Record<string, PluginMcpServer>;
}

export function replaceExactManagedFragment(
  config: string,
  startMarker: string,
  endMarker: string,
  knownFragments: string[],
  replacement: string,
): string {
  const validated = setMarkedBlock(config, startMarker, endMarker, replacement);
  const start = config.indexOf(startMarker);
  if (start < 0) return validated;
  const bodyStart = start + startMarker.length;
  const bodyEnd = config.indexOf(endMarker, bodyStart);
  const body = config.slice(bodyStart, bodyEnd);
  const next = replacement.trim();
  const currentOffset = body.indexOf(next);
  if (currentOffset >= 0) {
    if (body.indexOf(next, currentOffset + next.length) >= 0) {
      throw new Error("Refusing to replace an ambiguous exact known managed fragment");
    }
    const remainder = body.slice(0, currentOffset) + body.slice(currentOffset + next.length);
    if (MCP_TABLE_HEADER.test(remainder)) {
      throw new Error("Refusing to retain unmatched MCP tables in the managed block");
    }
    return config;
  }

  const candidates = [...knownFragments].map((fragment) => fragment.trim())
    .filter(Boolean).sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    const offset = body.indexOf(candidate);
    if (offset < 0) continue;
    if (body.indexOf(candidate, offset + candidate.length) >= 0) {
      throw new Error("Refusing to replace an ambiguous exact known managed fragment");
    }
    const remainder = body.slice(0, offset) + body.slice(offset + candidate.length);
    if (MCP_TABLE_HEADER.test(remainder)) {
      throw new Error("Refusing to retain unmatched MCP tables in the managed block");
    }
    const absolute = bodyStart + offset;
    return config.slice(0, absolute) + next + config.slice(absolute + candidate.length);
  }
  throw new UnknownManagedFragmentError([next, ...candidates]);
}

export function migrateExactUnmanagedMcpArg(
  config: string,
  name: string,
  oldArg: string,
  newArg: string,
  startMarker: string,
  endMarker: string,
): { config: string; migrated: boolean } {
  const source = String(config);
  const range = managedConfig.mcpTableRange(source, name);
  if (!range) return { config: source, migrated: false };
  const managedStart = source.indexOf(startMarker);
  const managedEnd = source.indexOf(endMarker);
  if (managedStart >= 0 && managedEnd > managedStart
      && range.start > managedStart && range.start < managedEnd) {
    return { config: source, migrated: false };
  }

  let rewritten;
  try {
    rewritten = rewriteExactTomlStringArgs(range.text, oldArg, newArg);
  } catch {
    throw new Error(`Retired bridge reference for mcp_servers.${name} could not be migrated safely`);
  }
  if (hasTomlStringReference(rewritten.text, oldArg)) {
    throw new Error(`Retired bridge reference for mcp_servers.${name} could not be migrated safely`);
  }
  if (!rewritten.migrated) return { config: source, migrated: false };
  return {
    config: source.slice(0, range.start) + rewritten.text + source.slice(range.end),
    migrated: true,
  };
}

function unmanagedMcpText(config: string, startMarker: string, endMarker: string): string {
  const start = config.indexOf(startMarker);
  const end = config.indexOf(endMarker);
  const unmanaged = start >= 0 && end > start
    ? config.slice(0, start) + config.slice(end + endMarker.length) : config;
  let active = false;
  return unmanaged.split(/(?<=\n)/).filter((line) => {
    if (/^\s*\[/.test(line)) active = /^\s*\[\s*mcp_servers\s*\./.test(line);
    return active;
  }).join("");
}

export function preserveConfigUpgrade(
  config: string,
  options: ConfigUpgradeOptions,
): ConfigUpgradeResult {
  const hadManagedBlock = config.includes(options.startMarker);
  const managedWasCurrent = hadManagedBlock && config
    .slice(config.indexOf(options.startMarker), config.indexOf(options.endMarker))
    .includes(options.managedReplacement.trim());
  const migratedMcpServers: string[] = [];
  let next = config;
  for (const name of new Set(options.mcpServerNames)) {
    const migration = migrateExactUnmanagedMcpArg(
      next, name, options.retiredBridge, options.currentBridge,
      options.startMarker, options.endMarker,
    );
    next = migration.config;
    if (migration.migrated) migratedMcpServers.push(name);
  }
  if (hasTomlStringReference(
    unmanagedMcpText(next, options.startMarker, options.endMarker),
    options.retiredBridge,
  )) {
    throw new Error("Retired bridge reference remains in an unknown unmanaged MCP table");
  }
  next = replaceExactManagedFragment(
    next, options.startMarker, options.endMarker,
    options.knownManagedFragments, options.managedReplacement,
  );
  return {
    config: next,
    managedFragment: !hadManagedBlock ? "created" : managedWasCurrent ? "current" : "replaced",
    migratedMcpServers,
  };
}

// Issue #212. Written only when config.toml has no top-level value of its own.
export const DEFAULT_REASONING_EFFORT = "xhigh";

export interface ReasoningEffortReport {
  status: "configured" | "preserved-existing";
  value: string;
}

// The receipt shows a plain TOML string unquoted and anything else as written.
function reportedValue(raw: string): string {
  const quoted = /^(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(raw);
  return quoted ? quoted[1] ?? quoted[2] : raw;
}

export function prepareManagedConfig(config: string, options: ManagedConfigOptions) {
  let baseline = config;
  let result: ReturnType<typeof prepareAnchoredConfig>;
  try {
    result = prepareAnchoredConfig(config, options);
  } catch (error) {
    // Issue #274. A block the Codex app split around its trust tables is matched
    // again once the split is undone; any other unknown block still refuses.
    if (!(error instanceof UnknownManagedFragmentError)) throw error;
    const anchored = reanchorSplitManagedBlock(config, options.startMarker, options.endMarker, error.knownFragments);
    if (!anchored) throw error;
    baseline = anchored;
    result = { ...prepareAnchoredConfig(anchored, options), managedFragment: "replaced" as const };
  }
  preserveExternalPostToolPositions(baseline, result.config, options.startMarker, options.endMarker);
  return result;
}

function prepareAnchoredConfig(config: string, options: ManagedConfigOptions) {
  const retiredMcpServers = options.retiredMcpServerNames.map((name) => ({
    name,
    status: managedConfig.removeMcpTables(config, [name]) !== config ? "removed" : "absent",
  }));
  let migrated = managedConfig.removeMcpTables(config, options.retiredMcpServerNames);
  const recoveredMcpServers = new Set<string>();
  const registryProjections = options.registryProjections.map((projection) => {
    if (projection.transport === "http" || projection.transport === "stdio") return projection;
    const recovered = recoverManagedMcpProjection(
      projection.name, migrated,
      {
        node: options.node, runtime: options.registryRuntime,
        registry: options.registry, registryBridge: options.registryBridge,
      },
      { start: options.startMarker, end: options.endMarker },
    );
    if (recovered) recoveredMcpServers.add(projection.name);
    return recovered ?? projection;
  });
  const effectiveOptions = { ...options, registryProjections };
  const repaired = repairManagedMcp(migrated, { ...effectiveOptions, mcpServers: [] });
  migrated = repaired.config;
  const { existingManagedMcp, mcpServers, repairedMcpServers } = repaired;
  const retiredBridge = path.join(path.dirname(options.registryBridge), "registry-http-bridge.js");
  const pluginMcpServers = Object.fromEntries(Object.entries(options.pluginMcpServers)
    .filter(([name]) => !managedConfig.hasUnmanagedMcp(
      config, name, options.startMarker, options.endMarker,
    )));
  // Optional servers render first, so neither block form is a substring of the other.
  const optionalVariants = [options.optionalPluginMcpServers || {}, ...(options.predecessorOptionalPluginMcpServers || [])];
  const optionalNames = new Set(optionalVariants.flatMap((servers) => Object.keys(servers)));
  const withoutOptional = (servers: Record<string, PluginMcpServer>) =>
    Object.fromEntries(Object.entries(servers).filter(([name]) => !optionalNames.has(name)));
  const base: PluginSet = {
    plugins: withoutOptional(pluginMcpServers), predecessorPlugins: withoutOptional(options.pluginMcpServers),
  };
  const pluginSets: PluginSet[] = [base, ...optionalVariants
    .map((servers) => Object.fromEntries(Object.entries(servers)
      .filter(([name]) => !managedConfig.hasUnmanagedMcp(config, name, options.startMarker, options.endMarker))))
    .filter((optional) => Object.keys(optional).length)
    .map((optional) => ({ plugins: { ...optional, ...base.plugins },
      predecessorPlugins: { ...optional, ...base.predecessorPlugins } }))];
  const operatorEffort = topLevelSetting(migrated, "model_reasoning_effort");
  let reasoningEffort: ReasoningEffortReport;
  let next = migrated;
  if (operatorEffort === undefined) {
    reasoningEffort = { status: "configured", value: DEFAULT_REASONING_EFFORT };
    next = setTopLevelSetting(next, "model_reasoning_effort", JSON.stringify(DEFAULT_REASONING_EFFORT));
  } else {
    reasoningEffort = { status: "preserved-existing", value: reportedValue(operatorEffort) };
  }
  const previousNodes = managedNodePaths(config, options.startMarker, options.endMarker, options.node);
  next = configureMemoryNotify(next, options.node, options.memoryNotifyHook, previousNodes);
  next = enableHooks(next);
  const retiredTable = retireUnmanagedCentralBrainTable(next, options.retiredCentralBrain, options.startMarker, options.endMarker);
  next = retiredTable.config;
  const beforeCheckout = next;
  const entry = options.controlPlaneHook ? parityConfig.controlPlaneEntry(options.hookDir) : undefined;
  next = pointControlPlaneHooksAt(next, entry, options.startMarker, options.endMarker);
  const outbox = options.controlPlaneOutbox;
  const outboxRoot = outbox ? projectOutboxWritableRoot(next, outbox, options.startMarker, options.endMarker) : undefined;
  if (outboxRoot) next = outboxRoot.config;
  const withoutOutbox = { ...effectiveOptions, mcpServers, pluginMcpServers, outboxWritableRoot: undefined };
  const externalDeliverHooks = hasExactExternalDeliverHooks(
    next, options.node, entry, options.controlPlaneHook, options.startMarker, options.endMarker,
  );
  const currentRenderOptions = { ...withoutOutbox,
    omitDeliveryHooks: externalDeliverHooks,
    outboxWritableRoot: outboxRoot?.managedTable ? outbox : undefined };
  // A block may carry the table for this outbox or for the one an earlier
  // install named, and the current render may have dropped it since.
  const outboxVariants = [...new Set([outbox, ...managedOutboxRoots(next, options.startMarker, options.endMarker)])]
    .filter((root): root is string => Boolean(root))
    .map((root) => ({ ...withoutOutbox, outboxWritableRoot: root }));
  // Every block shape below is known with and without the optional plugin servers.
  const knownFragments = ({ plugins, predecessorPlugins }: PluginSet): string[] => {
    const currentVariants = [withoutOutbox, ...outboxVariants]
      .flatMap(value => [value, {...value, observationPublisher: undefined}])
      .flatMap((value) => value.messagingClient
        ? [value, { ...value, messagingClient: { ...value.messagingClient, enabled: !value.messagingClient.enabled } }]
        : [value])
      .flatMap((value) => value.controlPlaneHook ? [value, { ...value, omitDeliveryHooks: true }] : [value])
      .flatMap((value) => [value, { ...value, windowsHookCommands: false }])
      .map((value) => ({ ...value, pluginMcpServers: plugins, contextWorkspace: undefined }));
    const beforeControlPlaneWindowsVariants = currentVariants
      .map((value) => ({ ...value, controlPlaneHook: undefined }));
    // Every block written before issue #68 lacks the commandWindows forms.
    const beforeWindowsCommands = { ...withoutOutbox, contextWorkspace: undefined, pluginMcpServers: plugins, windowsHookCommands: false };
    // Every block written before the control-plane hook existed lacks it.
    const beforeControlPlane = { ...beforeWindowsCommands, controlPlaneHook: undefined };
    const currentLegacyOptions = { ...beforeControlPlane, memoryProvider: "unconfigured" as const };
    const legacyRenderOptions = { ...currentLegacyOptions, observationStopHook: false };
    const predecessorRenderOptions = {
      ...legacyRenderOptions,
      mcpServers: registryProjections.flatMap<McpServerSpec>((projection) => {
        if (projection.transport === "http") {
          return [{
            name: projection.name,
            transport: "http",
            authentication: "registry-bearer",
            sourceName: projection.authentication === "registry-bearer"
              ? projection.sourceName : options.mcpCompatibility?.sourceNames?.[projection.name] ?? projection.name,
          }];
        }
        return projection.transport === "stdio" ? [projection] : [];
      }),
      pluginMcpServers: predecessorPlugins,
      registryBridge: retiredBridge,
    };
    const historical = recognizeHistoricalManagedConfig(
      next, { ...currentRenderOptions, contextWorkspace: undefined, pluginMcpServers: plugins }, legacyRenderOptions, predecessorRenderOptions,
    );
    return [
      ...currentVariants.map(value => parityConfig.render({ ...value, contextWorkspace: options.contextWorkspace })),
      ...[...currentVariants, ...beforeControlPlaneWindowsVariants].flatMap((value) =>
        [parityConfig.renderBeforeShellDispatcher(value), parityConfig.renderBeforeAdaptedDirectGuards(value),
          parityConfig.renderBeforeAdaptedIntentHook(value), parityConfig.renderBeforeSelfAssignment(value),
          // The immediate predecessor was also installed with this exact workspace binding.
          ...(options.contextWorkspace === undefined ? [] : [parityConfig.renderBeforeSelfAssignment({
            ...value, contextWorkspace: options.contextWorkspace,
          })])]),
      ...[...currentVariants, ...beforeControlPlaneWindowsVariants,
        beforeWindowsCommands, beforeControlPlane].flatMap((current) => {
        const previousStop = { ...current, observationStopHook: false };
        return [...managedFragmentFamily(current, previousStop),
          ...retiredCentralBrainFragments(current, previousStop, options.retiredCentralBrain)];
      }).flatMap((fragment) => [fragment, parityConfig.withLegacySharedGuards(fragment)]),
      parityConfig.render(currentLegacyOptions),
      parityConfig.render(legacyRenderOptions),
      parityConfig.renderPreviousNudges({ ...predecessorRenderOptions, registryBridge: options.registryBridge }),
      parityConfig.renderPreviousNudgesPrefix({ ...predecessorRenderOptions, registryBridge: options.registryBridge }),
      parityConfig.renderLegacyJavaScript(predecessorRenderOptions),
      parityConfig.renderLegacyJavaScriptPrefix(predecessorRenderOptions),
    ].concat(historical);
  };
  const upgrade = preserveConfigUpgrade(next, {
    startMarker: options.startMarker,
    endMarker: options.endMarker,
    knownManagedFragments: withManagedNodePaths(pluginSets.flatMap(knownFragments), options.node, previousNodes),
    managedReplacement: parityConfig.render(currentRenderOptions),
    mcpServerNames: registryProjections.map(({ name }) => name),
    retiredBridge,
    currentBridge: options.registryBridge,
  });
  return {
    ...upgrade,
    // A block that differed only in the checkout path was still rewritten.
    managedFragment: upgrade.managedFragment === "current" && next !== beforeCheckout ? "replaced" : upgrade.managedFragment,
    migratedMcpServers: [...new Set([...upgrade.migratedMcpServers, ...repairedMcpServers])],
    repairedMcpServers,
    recoveredMcpServers,
    existingManagedMcp,
    pluginMcpServers,
    retiredMcpServers: [...retiredMcpServers, ...retiredTable.tables],
    outboxWritableRoot: outboxRoot?.status,
    reasoningEffort,
  };
}
