// Shared fakes for the model backend tests (issue #1020): an inventory, a
// recording Confluence session, a fake CLI gate and a fake model child. No
// network, no process, no clock.
import { requestError, SCOPES, type ConfluenceSession, type RequestSpec } from "./confluence-contract.mts";
import { CODEX_DISABLED_FEATURES, type GateExec } from "./confluence-model-gates.mts";
import type { ChildResult, ChildRun, SpawnModel } from "./confluence-model-runner.mts";
import type { IndexedPage, SpaceIndex } from "./confluence-space-index.mts";

export function indexOf(pages: [string, string, string?][]): SpaceIndex {
  const index: SpaceIndex = { byId: new Map(), byTitle: new Map(), parents: new Set() };
  for (const [id, title, parentId] of pages) {
    const page: IndexedPage = { id, title, parentId: parentId ?? null };
    index.byId.set(id, page);
    index.byTitle.set(title.toLowerCase(), page);
    if (parentId) index.parents.add(parentId);
  }
  return index;
}

export const PAGES = indexOf([
  ["1", "Development"],
  ["2", "Rotating the service account credential", "1"],
  ["3", "Credential file expired in the nightly job", "1"],
  ["4", "Printer setup", "1"],
  ["5", "node.js upgrade notes for vite-plugin", "1"],
]);

export function recordingSession(body: unknown = { results: [] }) {
  const specs: RequestSpec[] = [];
  const session: ConfluenceSession = { async request(spec) { specs.push(spec); return { status: 200, json: body }; } };
  return { session, specs };
}

export const refusingSession = (status: number): ConfluenceSession => ({
  async request(spec) { throw requestError({ method: "GET", path: spec.path, scope: SCOPES.get }, status, {}); },
});

// `claude --version`, `codex --version` and `codex features list` as the probe read them.
export function fakeGate(options: { claude?: string; codex?: string; features?: readonly string[]; fail?: boolean } = {}) {
  const calls: string[][] = [];
  const exec: GateExec = async (file, args) => {
    calls.push([file, ...args]);
    if (options.fail) throw new Error("spawn failed");
    if (args[0] === "features") return { stdout: (options.features ?? CODEX_DISABLED_FEATURES).map((n) => `${n}  stable  true`).join("\n") };
    return { stdout: /codex/.test(file) ? `codex-cli ${options.codex ?? "0.169.0"}` : `${options.claude ?? "2.1.332"} (Claude Code)` };
  };
  return { exec, calls };
}

export const claudeEnvelope = (result: string, model = "claude-haiku-5-5", extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "result", subtype: "success", is_error: false, result,
  modelUsage: { [model]: { inputTokens: 2, outputTokens: 30, cacheCreationInputTokens: 2500, cacheReadInputTokens: 0 } }, ...extra,
});

export const codexStream = (items: string[] = ["agent_message"]) => [
  JSON.stringify({ type: "thread.started", thread_id: "t" }),
  ...items.map((type) => JSON.stringify({ type: "item.completed", item: { id: "i", type } })),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 900, output_tokens: 40 } }),
].join("\n");

export function fakeChild(answer: Partial<ChildResult> | ((run: ChildRun) => Partial<ChildResult>)) {
  const runs: ChildRun[] = [];
  const spawn: SpawnModel = async (run) => {
    runs.push(run);
    const got = typeof answer === "function" ? answer(run) : answer;
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...got };
  };
  return { spawn, runs };
}
