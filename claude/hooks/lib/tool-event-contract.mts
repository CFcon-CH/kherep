// Issue #808. The tool event contract: one row per wired PreToolUse guard, the tools it
// judges and the tool_input keys it reads. Data only; tool-event-shape.mts classifies an
// event against it. `shared` is the event the guard file itself reads (Claude, and Codex
// after the adapter's normalization); `codex` is the native Codex event that the adapter
// classifies before it normalizes it. A guard without `codex` is not classified by the adapter.
export interface ToolEventShape {
  // Exact tool names, and regular expression sources for tool name families.
  readonly tools: readonly string[];
  readonly toolPatterns?: readonly string[];
  // One of these keys must hold a string; [] needs an object only; null: tool_input is not read.
  readonly inputKeys: readonly string[] | null;
  // A string tool_input is the command itself (Codex functions.exec and apply_patch).
  readonly stringInput?: boolean;
}
export interface ToolEventContractRow { readonly shared: ToolEventShape; readonly codex?: ToolEventShape }

const SHELL = ["Bash", "PowerShell"];
const CODEX_SHELL = ["shell_command", "exec_command", "functions.exec"];
const CODEX_KEYS = ["command", "source", "code", "input", "patch"];
const SHELL_ROW = { shared: { tools: SHELL, inputKeys: ["command"] },
  codex: { tools: [...SHELL, ...CODEX_SHELL], inputKeys: CODEX_KEYS, stringInput: true } };
const CLOUD = ["Agent", "Task", "Workflow", "WebSearch", "WebFetch"];
const FILES = ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"];

export const TOOL_EVENT_CONTRACT = {
  "commit-guard": SHELL_ROW,
  "deploy-guard": { shared: { tools: SHELL, inputKeys: ["command"] },
    codex: { tools: ["Bash", ...CODEX_SHELL], inputKeys: CODEX_KEYS, stringInput: true } },
  "main-checkout-guard": SHELL_ROW,
  "module-label-guard": SHELL_ROW,
  // Codex runs its own privacy guard file (codex-privacy-boundary-guard.mts) under this row.
  "privacy-boundary-guard": { shared: { tools: [...FILES, ...SHELL, ...CLOUD], toolPatterns: ["^mcp__"], inputKeys: [] },
    codex: { tools: [...FILES, "apply_patch", "Bash", ...CODEX_SHELL, ...CLOUD, "spawn_agent"], toolPatterns: ["^mcp__"], inputKeys: [], stringInput: true } },
  "secret-output-guard": { shared: { tools: SHELL, inputKeys: ["command"] } },
  "playwright-file-guard": { shared: { tools: [], toolPatterns: ["^mcp__.+__browser_navigate$"], inputKeys: ["url"] } },
  "dispatch-contract-guard": { shared: { tools: ["Agent", "Task"], inputKeys: ["prompt"] } },
  "atlassian-destructive-guard": { shared: { tools: [], toolPatterns: ["^mcp__.+__executeDestructive$"], inputKeys: null } },
  "obs-handback-gate": { shared: { tools: ["SubagentHandback"], inputKeys: ["message"] } },
} as const satisfies Record<string, ToolEventContractRow>;
