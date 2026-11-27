// The semantic half of the neighbour search: one seam, two backends (issue
// #1020). `twg` asks Rovo search (confluence-semantic-twg.mts); `model` ranks a
// pool built on the host with the small model of the calling runtime
// (confluence-semantic-model.mts). Everything either returns is a PROPOSAL,
// filtered afterwards against the space index in confluence-related.mts.
//
// A failed search and a search with no hits are different facts and must not
// collapse into the same empty array (golden rule 12). The reason travels with
// the result, so a caller can say "nothing matched" only when nothing matched.
// No backend ever calls the other: a failure is reported, never papered over.
import type { ConfluenceSession } from "./confluence-contract.mts";
import { runtimeOf, type Runtime } from "./confluence-runtime-label.mts";
import { modelProposals, type ModelDeps } from "./confluence-semantic-model.mts";
import { twgProposals, type TwgDeps } from "./confluence-semantic-twg.mts";
import type { SpaceIndex } from "./confluence-space-index.mts";

export { itemsFrom, resolveTwg, titlesFrom, twgProposals, type TwgDeps, type TwgLookup } from "./confluence-semantic-twg.mts";
// The name every caller and test used before #1020. It stays the twg backend.
export { twgProposals as semanticProposals } from "./confluence-semantic-twg.mts";

// One search hit as the search returned it. The id is the Confluence page id
// when the hit carried a readable one, else empty and the title decides; the
// snippet is the content excerpt the search returned (issue #736).
export interface ProposalItem {
  id: string;
  title: string;
  snippet: string;
}

export interface Proposals {
  titles: string[];
  // The same hits with id and snippet, in the same order. Optional so that an
  // injected search returning titles only still type-checks.
  items?: ProposalItem[];
  // Set when the search could not run. Absent means the search ran; an empty
  // titles list is then a measured result rather than a missing one.
  error?: string;
  // Which backend answered: "twg", "model:claude-code" or "model:codex". Set by
  // the dispatcher only.
  backend?: string;
}

export type ExecLike = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

// What the model backend needs from the caller: the inventory the caller has
// already loaded, the session for the one CQL request, and the space key.
export interface SemanticPool {
  session: ConfluenceSession;
  spaceKey: string;
  pages: SpaceIndex;
}

// What a caller passes: the space key twg narrows to, and the pool the model
// backend ranks. A caller that holds the inventory passes both.
export interface SemanticOptions {
  spaceKey?: string;
  pool?: SemanticPool;
}

export type SemanticBackend = "model" | "twg";

// The default per runtime. Each value is set from that runtime's comparison
// against twg (issue #1020): passed = "model", not passed or not run = "twg".
// Claude passed all five criteria on 2026-11-27 (N = 20, P3 38 vs 32); Codex
// has no tool-free Luna path yet and stays on twg.
// Versioned and installed like every broker file; no host setting carries it.
export const DEFAULT_BACKEND: Readonly<Record<Runtime, SemanticBackend>> = { "claude-code": "model", codex: "twg" };

export interface SemanticDeps extends TwgDeps, ModelDeps {
  defaults?: Readonly<Record<Runtime, SemanticBackend>>;
}

export type SemanticSearch = (query: string, limit?: number, deps?: SemanticDeps) => Promise<Proposals>;

// Precedence: an injected search (tests) never reaches here; then
// KHEREP_SEMANTIC_BACKEND; then the default of the bound runtime. A call without
// a bound runtime keeps the pre-#1020 behaviour, the twg backend.
export async function semanticSearch(query: string, limit = 25, deps: SemanticDeps = {}): Promise<Proposals> {
  const env = deps.env ?? process.env;
  const chosen = (env.KHEREP_SEMANTIC_BACKEND ?? "").trim();
  if (chosen && chosen !== "model" && chosen !== "twg") {
    return { titles: [], items: [], error: `semantic search did not run: KHEREP_SEMANTIC_BACKEND "${chosen}" is not one of model, twg` };
  }
  const backend = (chosen || (deps.runtime ? (deps.defaults ?? DEFAULT_BACKEND)[deps.runtime] : "twg")) as SemanticBackend;
  if (backend === "twg") return { ...(await twgProposals(query, limit, { ...deps, env })), backend: "twg" };
  const answer = await modelProposals(query, limit, { ...deps, env });
  return { ...answer, backend: deps.runtime ? `model:${deps.runtime}` : "model" };
}

// The broker entry file is the runtime (design section 3): each entry binds
// its own credential variable here once. No environment sniffing.
export function semanticFor(credEnv: string, env?: Record<string, string | undefined>): SemanticSearch {
  const runtime = runtimeOf(credEnv);
  return (query, limit, deps = {}) => semanticSearch(query, limit, { env, ...deps, runtime });
}
