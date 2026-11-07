import path from "node:path";
import { renderObservationPublisher, type ObservationProjection } from "./observation-projection.mts";
import { nativeCommand } from "./memory-provider.mts";
import { renderOutboxWritableRoot } from "./outbox-writable-root.mts";

import type { McpServerSpec, PluginMcpServer } from "./contracts.mts";

const CODEBASE_MEMORY_READ_ONLY_TOOLS = Object.freeze([
  "index_status", "list_projects", "search_graph", "search_code",
  "trace_path", "detect_changes", "query_graph", "get_graph_schema",
  "get_code_snippet", "get_architecture",
]);

export interface HookSpec {
  command: string;
  commandWindows?: string;
  timeout?: number;
  status?: string;
}

interface HookOptions {
  status?: string;
  timeout?: number;
}

// Options for the MCP part alone; the hook part needs the full RenderOptions.
export interface McpRenderOptions {
  observationPublisher?: ObservationProjection;
  // "central-brain" is retired (OP-1429). The installer never renders it as the
  // current block; it only reproduces blocks older installers wrote, so the
  // upgrade can recognise and replace them (see retired-central-brain.mts).
  memoryProvider?: "unconfigured" | "central-brain";
  mcpServers: McpServerSpec[];
  pluginMcpServers?: Record<string, PluginMcpServer>;
  node?: string;
  registry?: string;
  registryBridge?: string;
}

export interface MessagingClientRenderOptions {
  enabled: boolean;
  bridge: string;
  intentHook: string;
  configRoot: string;
}

export interface RenderOptions extends McpRenderOptions {
  contextHook: string;
  contextWorkspace?: string;
  hookDir: string;
  node: string;
  nativeHooks?: { contextCli: string; captureCli: string; profile: string; extraCaCertificates?: string };
  // The control-plane delivery hook in the checkout (issue #31, step 4). Blocks
  // written before it existed are rendered without it. Present means the
  // Control Plane hooks are wired; since issue #503 no command names it, the
  // installer writes it to the source pointer instead.
  controlPlaneHook?: string;
  // Exact external delivery groups keep ownership; attribution still runs.
  omitDeliveryHooks?: boolean;
  // Historical renders written before the busy hint existed.
  omitBusyHint?: boolean;
  // Historical renders written before the Atlassian destructive guard (#376).
  omitAtlassianDestructiveGuard?: boolean;
  // Exact pre-#386 shell group, for managed upgrade recognition only.
  omitShellDispatcher?: boolean;
  // Issue #507, part 4. Renders from before it, which ran the Atlassian, dispatch-contract
  // and Playwright guards directly, for managed upgrade recognition only.
  omitAdaptedDirectGuards?: boolean;
  // Issue #538. Renders from before it, which ran the messaging intent hook directly, for managed
  // upgrade recognition only; omitAdaptedDirectGuards implies it.
  omitAdaptedIntentHook?: boolean;
  omitSelfAssignmentHook?: boolean;
  // Legacy renders only: true was the combined macOS Stop hook, false was the
  // separate Windows observation Stop hook. Omitted means quiet observations.
  observationStopHook?: boolean;
  // Issue #68. false renders the blocks written before every hook carried a
  // commandWindows form, so the upgrade can recognise and replace them.
  windowsHookCommands?: boolean;
  // Issue #72. The Control Plane outbox as a sandbox writable root, rendered
  // only when the operator's config defines no sandbox_workspace_write table.
  outboxWritableRoot?: string;
  messagingClient?: MessagingClientRenderOptions;
}

function tomlString(value: unknown): string {
  return JSON.stringify(String(value));
}

export function command(...parts: unknown[]): string {
  const quote = (value: unknown): string => `"${String(value).replace(/"/g, '\\"')}"`;
  return parts.map(quote).join(" ");
}

// Only the workspace argument is encoded; generic command quoting stays unchanged.
export function contextCommand(node: string, hook: string, workspace?: string): string {
  return command(node, hook, ...(workspace === undefined ? []
    : ["--workspace-b64", Buffer.from(workspace, "utf8").toString("base64url")]));
}

export function hookGroup(event: string, matcher: string, hooks: HookSpec[]): string {
  const lines = [`[[hooks.${event}]]`];
  if (matcher) lines.push(`matcher = ${tomlString(matcher)}`);
  for (const hook of hooks) {
    lines.push("", `[[hooks.${event}.hooks]]`, 'type = "command"');
    lines.push(`command = ${tomlString(hook.command)}`);
    if (hook.commandWindows) lines.push(`commandWindows = ${tomlString(hook.commandWindows)}`);
    lines.push(`timeout = ${hook.timeout || 10}`);
    if (hook.status) lines.push(`statusMessage = ${tomlString(hook.status)}`);
  }
  return lines.join("\n");
}

function scriptHook(node: string, hookDir: string, script: string, options: HookOptions = {}): HookSpec {
  return {
    command: command(node, path.join(hookDir, script)),
    status: options.status,
    timeout: options.timeout,
  };
}

// args reach the guard after the phase (hook-adapter.mts passes them on unchanged).
function adaptedHook(node: string, hookDir: string, script: string, phase: string, options: HookOptions & { args?: string[] } = {}): HookSpec {
  return {
    command: command(node, path.join(hookDir, "codex-hook-adapter.mts"), path.join(hookDir, script), phase, ...(options.args ?? [])),
    status: options.status,
    timeout: options.timeout,
  };
}

// Issue #68. Codex on Windows runs a hook as `pwsh -NoProfile -Command <command>`,
// and a command that starts with a quoted path is a PowerShell ParserError. The
// call operator makes the same quoted parts a valid command in pwsh 7 and in
// Windows PowerShell 5.1; macOS and Linux keep running `command`.
function withWindowsCommand(hook: HookSpec): HookSpec {
  return { ...hook, commandWindows: `& ${hook.command}` };
}

const SHELL_MATCHER = "Bash|shell_command|exec_command|functions\\.exec";
const POST_EDIT_MATCHER = "Edit|Write|MultiEdit|apply_patch|functions\\.exec";

function postEditGroup(options: RenderOptions, predecessor = false): string {
  const hooks = predecessor
    ? ["manifest-watch.mts", "loc-watch.mts", "umlaut-translit-watch.mts", "simplify-nudge.mts"]
      .map((script) => adaptedHook(options.node, options.hookDir, script, "post"))
    : [scriptHook(options.node, options.hookDir, "codex-post-edit-checks.mts")];
  return hookGroup(
    "PostToolUse",
    POST_EDIT_MATCHER,
    options.windowsHookCommands === false ? hooks : hooks.map(withWindowsCommand),
  );
}

function withPreviousPostEditGroup(config: string, options: RenderOptions): string {
  const current = postEditGroup(options);
  if (!config.includes(current)) throw new Error("Current post-edit group is missing from rendered config");
  return config.replace(current, postEditGroup(options, true));
}

// Issue #503. Every Control Plane hook command names the stable entry point in
// the hook dir and a fixed hook name, never the source it runs: the commands,
// and so their Codex trust hashes, stay the same across upgrades. The entry
// point reads the source from the pointer the installer writes.
export const CONTROL_PLANE_ENTRY = "codex-control-plane-hook.mts";
export function controlPlaneEntry(hookDir: string): string {
  return path.join(hookDir, CONTROL_PLANE_ENTRY);
}
// The entry point starts the hook as a second Node process. Started with this
// flag it adds no type-stripping warning of its own on the Node versions that
// print one, so a hook run shows the stderr of a direct hook call. The shell
// dispatcher imports the entry point in-process and takes no flag.
export const ENTRY_NODE_FLAG = "--disable-warning=ExperimentalWarning";
export function controlPlaneCommand(node: string, hookDir: string, name: "deliver" | "attribution"): string {
  return command(node, ENTRY_NODE_FLAG, controlPlaneEntry(hookDir), name, "--runtime", "codex");
}

export function atlassianDestructiveGuard(node: string, hookDir: string): HookSpec {
  return { command: command(node, path.join(hookDir, "atlassian-destructive-guard.mts"), "--runtime", "codex") };
}

export function renderHooks(options: RenderOptions, previousNative = false): string {
  const { contextHook, hookDir, node } = options;
  const group = (event: string, matcher: string, hooks: HookSpec[]): string =>
    hookGroup(event, matcher, options.windowsHookCommands === false ? hooks : hooks.map(withWindowsCommand));
  const hook = (script: string, extra?: HookOptions): HookSpec => scriptHook(node, hookDir, script, extra);
  const adapted = (script: string, phase: string, extra?: HookOptions & { args?: string[] }): HookSpec => adaptedHook(node, hookDir, script, phase, extra);
  // Issue #507, part 4. The three guards that ran directly now run through the fail-closed
  // adapter; each stays the same entry of the same group, so no positional trust key moves.
  const direct = options.omitAdaptedDirectGuards;
  // Issue #538. The messaging intent hook runs through the adapter in pre-intent, same entry of the same group;
  // timeout 15 holds its 8 s receipt wait plus two Node starts inside the adapter's 13.5 s clock.
  const messaging = options.messagingClient;
  const intent = (client: MessagingClientRenderOptions): HookSpec => options.omitAdaptedIntentHook || direct
    ? { command: command(node, client.intentHook, "--config-root", client.configRoot) }
    : { command: command(node, path.join(hookDir, "codex-hook-adapter.mts"), client.intentHook, "pre-intent", "--config-root", client.configRoot),
      timeout: 15 };
  const native = (cli: string | undefined, timeout = 15): HookSpec[] =>
    options.memoryProvider === "central-brain" && options.nativeHooks && cli
      ? [{ command: previousNative ? command(node, cli, "codex", "--profile", options.nativeHooks.profile)
        : nativeCommand([node, cli, "codex", "--profile", options.nativeHooks.profile], process.platform,
          options.nativeHooks.extraCaCertificates), timeout }] : [];
  // Issue #325, PR-A. The attribution hook runs through the stable entry point
  // (issue #503), directly with --runtime codex: it never blocks, so it needs no
  // adapter. Its PreToolUse phase ends the shell group; its PostToolUse phase is
  // a group of its own after the only other one, which matches no shell tool.
  // Both placements keep every positional trust key rendered before them.
  const entry = controlPlaneEntry(hookDir);
  const attribution: HookSpec[] = options.controlPlaneHook
    ? [{ command: controlPlaneCommand(node, hookDir, "attribution") }] : [];
  const groups = [
    group("PreToolUse", "Read|Grep|Glob|Edit|Write|MultiEdit|apply_patch|Bash|shell_command|exec_command|functions\\.exec", [adapted("codex-privacy-boundary-guard.mts", "pre-privacy")]),
    group("PreToolUse", "Agent|spawn_agent|Task|Workflow|WebSearch|WebFetch|mcp__.*", [adapted("codex-privacy-boundary-guard.mts", "pre-privacy"),
      // Issue #376. Appended last: Codex trust keys are positional, and a new
      // group would move the key of every operator PreToolUse group after the
      // block. The guard denies through JSON on stdout itself, on Windows too.
      ...(options.omitAtlassianDestructiveGuard ? [] : [direct ? atlassianDestructiveGuard(node, hookDir)
        : adapted("atlassian-destructive-guard.mts", "pre", { args: ["--runtime", "codex"] })])]),
    group("PreToolUse", SHELL_MATCHER, options.omitShellDispatcher ? [adapted("commit-guard.mts", "pre"), adapted("deploy-guard.mts", "pre-no-transcript"),
      // Issue #325. Appended last: Codex trust keys are positional.
      adapted("main-checkout-guard.mts", "pre"), ...attribution] : [{
        command: command(node, path.join(hookDir, "codex-shell-checks.mts"),
          ...(options.controlPlaneHook ? [entry, "attribution", "--runtime", "codex"] : [])),
        timeout: 40,
      }]),
    group("PreToolUse", "Agent|spawn_agent", [direct ? hook("codex-dispatch-contract-guard.mts") : adapted("codex-dispatch-contract-guard.mts", "pre")]),
    group("PreToolUse", "mcp__playwright__browser_navigate", [direct ? hook("playwright-file-guard.mts") : adapted("playwright-file-guard.mts", "pre")]),
    ...(messaging?.enabled ? [group("PreToolUse", options.omitSelfAssignmentHook
      ? "^mcp__kherep_messaging__(sessions|send|inbox|reply|status)$"
      : "^mcp__kherep_messaging__(sessions|send|inbox|reply|status|assign_self)$", [intent(messaging)])] : []),
    group("UserPromptSubmit", "", [
      {
        command: contextCommand(node, contextHook, options.contextWorkspace),
        status: "Applying evidence-first routing",
      },
      hook("codex-research-first.mts"),
      ...native(options.nativeHooks?.contextCli),
    ]),
    postEditGroup(options),
    ...(attribution.length ? [group("PostToolUse", SHELL_MATCHER, attribution)] : []),
    group("SessionStart", "startup|resume|clear|compact", [
      { command: contextCommand(node, contextHook, options.contextWorkspace), status: "Loading Kherep Maestro" },
      hook("codex-cbm-reminder.mts"),
      // Read-only. Says whether the Confluence write path exists in tools/ yet,
      // and says it once when it appears. It replaces a proposed hourly task:
      // the state changes exactly once, and a session start is the moment the
      // answer can be used.
      hook("codex-confluence-delivery-check.mts"),
      ...native(options.nativeHooks?.contextCli),
      // Issue #275. LAST in the group, after the optional native hook: Codex trust
      // keys are positional, so every entry before it keeps its index and trust.
      hook("codex-hook-integrity.mts", { timeout: 30 }),
    ]),
    group("PreCompact", "manual|auto", [hook("codex-precompact-checkpoint.mts", { timeout: 30 })]),
    group("Stop", "", [
      hook("codex-research-stop.mts", { timeout: 30 }),
      ...(options.observationStopHook === true
        ? [hook("codex-observation-stop.mts", { timeout: 30 })]
        : [
          hook("codex-acceptance-gate.mts", { timeout: 30 }),
          ...(options.observationStopHook === false
            ? [hook("codex-observation-turn-completion.mts", { timeout: 30 })]
            : []),
        ]),
      ...native(options.nativeHooks?.captureCli, 10),
    ]),
    group("SubagentStart", ".*", [hook("codex-cbm-reminder.mts")]),
  ];
  if (options.controlPlaneHook && !options.omitDeliveryHooks) {
    // The entry point runs the deliver hook of the installed source.
    const deliver: HookSpec = { command: controlPlaneCommand(node, hookDir, "deliver") };
    groups.push(
      group("SessionStart", "startup|resume|clear|compact", [deliver]),
      group("UserPromptSubmit", "", [deliver]),
      group("Stop", "", [deliver]),
    );
  }
  if (options.controlPlaneHook && !options.omitBusyHint) {
    // Independent of edit dispatch and the three externally owned intake hooks.
    // Last PostToolUse group in this block; external positions are checked before installation.
    groups.push(group("PostToolUse", ".*", [{ command: controlPlaneCommand(node, hookDir, "deliver") }]));
  }
  if (native(options.nativeHooks?.captureCli).length)
    groups.push(group("SessionEnd", "other", native(options.nativeHooks?.captureCli, 3)));
  // Issue #326, PR-B. The last group of the block: Codex trust keys are
  // positional per event, and no earlier group or entry moves.
  groups.push(group("SubagentStop", "codex-obs", [hook("codex-obs-result-check.mts")]));
  return groups.join("\n\n");
}

export function renderMcpServer(server: McpServerSpec, options: McpRenderOptions): string {
  if (server.transport === "http" && server.authentication === "registry-bearer") {
    return renderRegistryMcpServer(server.name, server.sourceName ?? server.name, "KHEREP_", options);
  }
  const lines = [
    `[mcp_servers.${server.name}]`,
    "enabled = true",
    "required = false",
  ];
  if (server.transport === "http" && server.authentication === "native") {
    lines.push(`url = ${tomlString(server.url)}`);
  } else if (server.transport === "stdio") {
    lines.push(`command = ${tomlString(server.command)}`);
    lines.push(`args = [${(server.args ?? []).map(tomlString).join(", ")}]`);
    if (server.env) {
      const env = Object.entries(server.env)
        .map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ");
      lines.push(`env = { ${env} }`);
    }
  } else {
    throw new Error(`Unsupported MCP projection transport: ${server.name}`);
  }
  lines.push("startup_timeout_sec = 30.0", server.name === "central-brain"
    ? "tool_timeout_sec = 135.0" : "tool_timeout_sec = 60.0");
  if (server.name === "codebase-memory-mcp" && server.transport === "stdio") {
    for (const tool of CODEBASE_MEMORY_READ_ONLY_TOOLS) {
      lines.push(
        "",
        `[mcp_servers.${server.name}.tools.${tool}]`,
        'approval_mode = "approve"',
      );
    }
  }
  return lines.join("\n");
}

export function renderRegistryMcpServer(
  tableName: string, sourceName: string, envPrefix: string, options: McpRenderOptions,
): string {
  return [
    `[mcp_servers.${tableName}]`,
    "enabled = true",
    "required = false",
    `command = ${tomlString(options.node)}`,
    `args = [${tomlString(options.registryBridge)}]`,
    `env = { ${envPrefix}MCP_REGISTRY_FILE = ${tomlString(options.registry)}, ${envPrefix}MCP_SERVER_NAME = ${tomlString(sourceName)}, ${envPrefix}MCP_ALLOW_INSECURE_HTTP = "1" }`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
  ].join("\n");
}

export function renderMcp(options: McpRenderOptions): string {
  return options.mcpServers
    .map((server) => renderMcpServer(server, options)).join("\n\n");
}

export function renderPluginMcp(options: McpRenderOptions): string {
  return Object.entries(options.pluginMcpServers || {}).map(([name, server]) => {
    const lines = [
      `[mcp_servers.${name}]`,
      "enabled = true",
      "required = false",
    ];
    if (server.url) lines.push(`url = ${tomlString(server.url)}`);
    else {
      lines.push(`command = ${tomlString(server.command)}`);
      lines.push(`args = [${(server.args || []).map(tomlString).join(", ")}]`);
      if (server.env) {
        const env = Object.entries(server.env)
          .map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ");
        lines.push(`env = { ${env} }`);
      }
    }
    lines.push("startup_timeout_sec = 30.0", "tool_timeout_sec = 60.0");
    for (const tool of server.promptTools || []) {
      lines.push("", `[mcp_servers.${name}.tools.${tool}]`, 'approval_mode = "prompt"');
    }
    return lines.join("\n");
  }).join("\n\n");
}

function renderMessagingClient(options: RenderOptions): string {
  const client = options.messagingClient;
  if (!client?.enabled) return "";
  return [
    "[mcp_servers.kherep_messaging]",
    "enabled = true",
    "required = false",
    `command = ${tomlString(options.node)}`,
    `args = [${[client.bridge, "--config-root", client.configRoot].map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
  ].join("\n");
}

// The table sits between the header and the hooks, so the block without it is
// not a substring of the block with it, and an upgrade that drops the table
// cannot mistake the block that still has it for current.
function renderPrefix(options: RenderOptions): string {
  const sandbox = options.outboxWritableRoot ? [renderOutboxWritableRoot(options.outboxWritableRoot)] : [];
  return ["# Managed Kherep Codex Maestro parity projection.", ...sandbox, renderHooks(options)].join("\n\n");
}

export function render(options: RenderOptions): string {
  const messaging = renderMessagingClient(options);
  return [renderPrefix(options), renderMcp(options), renderPluginMcp(options), ...(options.observationPublisher ? [renderObservationPublisher(options.observationPublisher, options.node)] : []), ...(messaging ? [messaging] : []), ""]
    .join("\n\n");
}

// Exact predecessor of the Atlassian destructive guard (issue #376).
export function renderBeforeAtlassianDestructiveGuard(options: RenderOptions): string {
  return render({ ...options, omitSelfAssignmentHook: true, omitAtlassianDestructiveGuard: true, omitShellDispatcher: true, omitAdaptedDirectGuards: true });
}

export function renderBeforeShellDispatcher(options: RenderOptions): string {
  return render({ ...options, omitSelfAssignmentHook: true, omitShellDispatcher: true, omitAdaptedDirectGuards: true });
}

// Issue #507, part 4. Exact predecessor of the three adapted guards: the 3054123 render.
export function renderBeforeAdaptedDirectGuards(options: RenderOptions): string {
  return render({ ...options, omitSelfAssignmentHook: true, omitAdaptedDirectGuards: true });
}

// Issue #538. Exact predecessor of the adapted messaging intent entry: the c44f3e4 render.
export function renderBeforeAdaptedIntentHook(options: RenderOptions): string {
  return render({ ...options, omitSelfAssignmentHook: true, omitAdaptedIntentHook: true });
}

export function renderBeforeSelfAssignment(options: RenderOptions): string {
  return render({ ...options, omitSelfAssignmentHook: true });
}

// Exact predecessor of the busy-hint projection, which also predates the guard.
export function renderBeforeBusyHint(options: RenderOptions): string {
  return render({ ...options, omitSelfAssignmentHook: true, omitBusyHint: true, omitAtlassianDestructiveGuard: true, omitShellDispatcher: true, omitAdaptedDirectGuards: true });
}

// Exact predecessor of the dispatcher projection. Historical renderers below
// start from this byte shape before removing hooks that did not yet exist.
export function renderBeforePostEditDispatcher(options: RenderOptions): string {
  return withPreviousPostEditGroup(renderBeforeBusyHint(options), options);
}

// The previous-native, previous-nudges and JavaScript-era renders reproduce
// blocks written before issue #68, so none of them carries a commandWindows form.
function beforeWindowsCommands(options: RenderOptions): RenderOptions {
  return { ...options, omitSelfAssignmentHook: true, windowsHookCommands: false, omitBusyHint: true, omitAtlassianDestructiveGuard: true, omitShellDispatcher: true,
    omitAdaptedDirectGuards: true };
}

export function renderWithoutNativeHooks(options: RenderOptions): string {
  return render({ ...options, omitSelfAssignmentHook: true, nativeHooks: undefined });
}
export function renderPreviousNativeHooks(current: RenderOptions): string {
  const options = beforeWindowsCommands(current);
  const hooks = withoutHooks(
    withPreviousPostEditGroup(renderHooks(options, true), options),
    [...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS],
  );
  return ["# Managed Kherep Codex Maestro parity projection.", hooks, renderMcp(options), renderPluginMcp(options), ""].join("\n\n");
}

// The attribution hook as its entry-point argument appears in a rendered TOML
// string (issue #503), in its own entry and in the shell dispatcher entry alike.
const ATTRIBUTION_ENTRY = String.raw`${CONTROL_PLANE_ENTRY}\" \"attribution\"`;

// Hooks that did not exist in the JavaScript-era projection. An older installer
// never wrote them, so a legacy fragment containing them would not match the
// block actually on disk - and matching that block is the only reason these
// renders exist. Renaming them to .js would not help: the line was never there
// in any spelling.
export const POST_LEGACY_HOOKS = [
  "codex-confluence-delivery-check",
  "codex-hook-integrity",
  "codex-observation-turn-completion",
  "codex-research-first",
  "codex-research-stop",
  // With its extension: a bare "main-checkout-guard" also matches a checkout
  // directory of that name in the control-plane hook path.
  "main-checkout-guard.mts",
  ATTRIBUTION_ENTRY,
  "codex-obs-result-check.mts",
];
const PRE_OBSERVATION_HOOKS = ["codex-observation-turn-completion"];
const PRE_RESEARCH_HOOKS = ["codex-research-first", "codex-research-stop"];
// Issue #325. Every render from before a hook predates each hook added after
// it, so each list extends the list of the hook that came next.
const PRE_OBS_RESULT_HOOKS = ["codex-obs-result-check.mts"];
const PRE_ATTRIBUTION_HOOKS = [ATTRIBUTION_ENTRY, ...PRE_OBS_RESULT_HOOKS];
const PRE_MAIN_CHECKOUT_HOOKS = ["main-checkout-guard.mts", ...PRE_ATTRIBUTION_HOOKS];
const PRE_INTEGRITY_HOOKS = ["codex-hook-integrity", ...PRE_MAIN_CHECKOUT_HOOKS];

// A group whose every entry was removed goes with them: its header block is
// followed by no entry of its own event. No render has an empty group.
function withoutHooks(config: string, names: readonly string[]): string {
  const blocks = config.split("\n\n").filter((block) => !names.some((name) => block.includes(name)));
  return blocks.filter((block, index) => {
    const event = /^\[\[hooks\.(\w+)\]\]/.exec(block)?.[1];
    return !event || blocks[index + 1]?.startsWith(`[[hooks.${event}.hooks]]`);
  }).join("\n\n");
}

function withoutPostLegacyHooks(config: string): string {
  return withoutHooks(config, POST_LEGACY_HOOKS);
}

const LEGACY_JAVASCRIPT_HOOKS = [
  "kherep-maestro-context", "codex-hook-adapter", "codex-privacy-boundary-guard",
  "codex-dispatch-contract-guard", "codex-cbm-reminder", "codex-precompact-checkpoint",
  "codex-acceptance-gate",
];

// OP-1138 renamed the four shared Claude nudges to .mts. Every predecessor
// projection on disk names them .js, and a known managed fragment has to
// reproduce what the OLDER installer WROTE - otherwise the block it left behind
// stops being recognised as managed and survives the upgrade unreplaced.
const LEGACY_SHARED_NUDGES = ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"];

function toLegacyJs(config: string, names: readonly string[]): string {
  let text = config;
  for (const name of names) text = text.replaceAll(`${name}.mts`, `${name}.js`);
  return text;
}

// Issue #237. The three shared Claude guards became .mts after the nudges, so
// every block written before that names them .js: the predecessor renders above
// and every render of the current family as an earlier installer wrote it.
const LEGACY_SHARED_GUARDS = ["commit-guard", "deploy-guard", "playwright-file-guard"];

function withLegacySharedNudges(config: string): string {
  return toLegacyJs(config, [...LEGACY_SHARED_GUARDS, ...LEGACY_SHARED_NUDGES]);
}

export function withLegacySharedGuards(config: string): string {
  return toLegacyJs(config, LEGACY_SHARED_GUARDS);
}

// Recognize the previous Kherep projection whose shared nudges still used .js.
export function renderPreviousNudgesPrefix(options: RenderOptions): string {
  const previous = { ...beforeWindowsCommands(options), nativeHooks: undefined };
  return withLegacySharedNudges(withoutPostLegacyHooks(
    withPreviousPostEditGroup(renderPrefix(previous), previous),
  ));
}

export function renderPreviousNudges(options: RenderOptions): string {
  const previous = { ...beforeWindowsCommands(options), nativeHooks: undefined };
  return withLegacySharedNudges(withoutPostLegacyHooks(renderBeforePostEditDispatcher(previous)));
}

// The projection as it stood BEFORE the post-legacy hooks existed. An installer
// one version back wrote exactly this block, so the upgrade has to recognise it
// as managed - otherwise it finds a block it cannot attribute and refuses to
// replace it, and the hook it was supposed to add never arrives.
//
// This is the step that was missed when the delivery-check hook was added on
// 2026-09-22: the legacy-era renders were filtered, the immediately previous one
// was not. Adding a hook means adding its name to POST_LEGACY_HOOKS, and these
// two functions then cover it without further thought.
export function renderBeforePostLegacyHooks(options: RenderOptions): string {
  return withoutPostLegacyHooks(renderBeforePostEditDispatcher(options));
}

export function renderBeforePostLegacyHooksWithoutNativeHooks(options: RenderOptions): string {
  return withoutPostLegacyHooks(renderBeforePostEditDispatcher({ ...options, nativeHooks: undefined }));
}

export function renderBeforeObservationHook(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher(options),
    [...PRE_OBSERVATION_HOOKS, ...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS]);
}

export function renderBeforeObservationHookWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher({ ...options, nativeHooks: undefined }),
    [...PRE_OBSERVATION_HOOKS, ...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS]);
}

export function renderBeforeResearchHooks(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher(options), [...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS]);
}

export function renderBeforeResearchHooksWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher({ ...options, nativeHooks: undefined }),
    [...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS]);
}

// Issue #275. The projection immediately before the Codex hook-integrity hook.
export function renderBeforeHookIntegrity(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher(options), PRE_INTEGRITY_HOOKS);
}

export function renderBeforeHookIntegrityWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher({ ...options, nativeHooks: undefined }), PRE_INTEGRITY_HOOKS);
}

// Issue #325. The projection immediately before the main-checkout guard.
export function renderBeforeMainCheckoutGuard(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher(options), PRE_MAIN_CHECKOUT_HOOKS);
}

export function renderBeforeMainCheckoutGuardWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher({ ...options, nativeHooks: undefined }),
    PRE_MAIN_CHECKOUT_HOOKS);
}

// Issue #325, PR-A. The projection immediately before the attribution hook.
export function renderBeforeAttributionHook(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher(options), PRE_ATTRIBUTION_HOOKS);
}

export function renderBeforeAttributionHookWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher({ ...options, nativeHooks: undefined }),
    PRE_ATTRIBUTION_HOOKS);
}

// Issue #326, PR-B. The projection immediately before the obs-result check.
export function renderBeforeObsResultCheck(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher(options), PRE_OBS_RESULT_HOOKS);
}

export function renderBeforeObsResultCheckWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderBeforePostEditDispatcher({ ...options, nativeHooks: undefined }),
    PRE_OBS_RESULT_HOOKS);
}

export function renderLegacyJavaScriptPrefix(options: RenderOptions): string {
  const previous = { ...beforeWindowsCommands(options), nativeHooks: undefined };
  let hooks = withoutPostLegacyHooks(withLegacySharedNudges(
    withPreviousPostEditGroup(renderHooks(previous), previous),
  ));
  for (const name of LEGACY_JAVASCRIPT_HOOKS) {
    hooks = hooks.replaceAll(`${name}.mts`, `${name}.js`);
  }
  return ["# Managed Kherep Codex Maestro parity projection.", hooks].join("\n\n");
}

export function renderLegacyJavaScript(options: RenderOptions): string {
  return [
    renderLegacyJavaScriptPrefix(options),
    renderMcp(options),
    renderPluginMcp(options),
    "",
  ].join("\n\n");
}
