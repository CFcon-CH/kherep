import { record, validateCatalog, type ModelCatalog } from "./model-policy.mts";

export interface CatalogClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  shutdown(): Promise<boolean>;
}
export interface CatalogLimits { timeoutMs?: number; maxPages?: number }
export type CatalogStage = "start" | "catalog" | "cleanup";

// Internal: carries which stage failed first and whether the owned process was confirmed gone.
// It never leaves readAvailableModels, which maps it to the redacted CatalogReadError.
export class CatalogStageError extends Error {
  readonly stage: CatalogStage;
  cleanupConfirmed: boolean;
  constructor(stage: CatalogStage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.stage = stage;
    this.cleanupConfirmed = stage !== "cleanup";
  }
}
function tag(error: unknown, stage: CatalogStage): CatalogStageError {
  return error instanceof CatalogStageError ? error : new CatalogStageError(stage, `Model catalog ${stage} failed`, { cause: error });
}

async function confirmCleanup(client: CatalogClient, failure: CatalogStageError | undefined): Promise<void> {
  let confirmed = false;
  try { confirmed = await client.shutdown(); } catch { confirmed = false; }
  if (!confirmed) {
    // The first failure wins; the unconfirmed cleanup travels on it.
    if (failure) failure.cleanupConfirmed = false;
    else throw new CatalogStageError("cleanup", "Model catalog process cleanup was not confirmed");
  }
}

// This metadata-only protocol never opens a thread, starts a turn or requests inference.
// The caller owns exactly one app-server and must obtain confirmed cleanup before using the result.
export async function collectModelCatalog(client: CatalogClient, limits: CatalogLimits = {}): Promise<ModelCatalog> {
  const timeoutMs = limits.timeoutMs ?? 10_000;
  const maxPages = limits.maxPages ?? 100;
  const deadline = Date.now() + timeoutMs;
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const stage = method === "initialize" ? "start" : "catalog";
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CatalogStageError(stage, "Model catalog deadline exceeded");
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([client.request(method, params, remaining), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CatalogStageError(stage, "Model catalog deadline exceeded")), remaining);
      })]);
    } catch (error) { throw tag(error, stage); }
    finally { clearTimeout(timer); }
  };
  let failure: CatalogStageError | undefined;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxPages) || maxPages <= 0) {
      throw new CatalogStageError("start", "Invalid catalog limits");
    }
    await request("initialize", { clientInfo: { name: "kherep_model_catalog", version: "1" }, capabilities: null });
    try { client.notify("initialized", {}); } catch (error) { throw tag(error, "start"); }
    const models: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!record(result) || !Array.isArray(result.data) || result.data.length > 100
        || !(result.nextCursor === null || typeof result.nextCursor === "string" && result.nextCursor.length > 0)) {
        throw new CatalogStageError("catalog", "Malformed model catalog page");
      }
      models.push(...result.data);
      if (result.nextCursor === null) return validateCatalog({ complete: true, models });
      cursor = result.nextCursor as string;
      if (cursors.has(cursor)) throw new CatalogStageError("catalog", "Repeated model catalog cursor");
      cursors.add(cursor);
    }
    throw new CatalogStageError("catalog", "Model catalog page limit exceeded");
  } catch (error) {
    failure = tag(error, "catalog");
    throw failure;
  } finally {
    await confirmCleanup(client, failure);
  }
}
