import { isMessageId } from "../../protocol-messages.mts";
import { registryStub, type Env } from "./env.mts";
import { fail, json, readJsonObject } from "./http.mts";

// Only handleApi calls this, after the existing Access identity check.
export async function handleMessageHolds(request: Request, env: Env, actor: string): Promise<Response> {
  const url = new URL(request.url), parts = url.pathname.split("/").filter(Boolean);
  const registry = registryStub(env);
  if (parts.length === 2 && request.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return fail(400, "limit must be 1-200");
    return json({ holds: await registry.listMessageHolds(limit) });
  }
  if (parts.length !== 4 || parts[3] !== "release" || request.method !== "POST") return fail(404, "not found");
  if (!isMessageId(parts[2])) return fail(400, "invalid hold id");
  const body = await readJsonObject(request);
  if (!body || Object.keys(body).length !== 1 || typeof body.expectedVersion !== "number"
    || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) return fail(400, "invalid expectedVersion");
  const result = await registry.releaseMessageHold(parts[2], body.expectedVersion, actor);
  if (result.status !== 200) return fail(result.status, result.status === 404 ? "unknown hold" : "hold version changed");
  return json({ holdId: result.holdId, generation: result.generation, version: result.version });
}
