import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { CONTROL_PLANE_SESSION } from "../../protocol-messages.mts";
import { handleApi } from "../src/api.mts";
import type { Env } from "../src/env.mts";
import { BASE, enroll, newKey } from "./helpers.mts";

// Issue #965: refusal branches of the operator API behind the Access check.
// handleApi is called directly with a verified actor, as the release tests do.
const ACTOR = "synthetic-verified-operator";
const call = (path: string, init: RequestInit = {}, actor = ACTOR) =>
  handleApi(new Request(`${BASE}${path}`, init), env as Env, actor);
const post = (path: string, body: unknown) =>
  call(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
async function expectFail(response: Promise<Response>, status: number, error?: string): Promise<void> {
  const resolved = await response;
  expect(resolved.status).toBe(status);
  if (error) expect(await resolved.json()).toMatchObject({ error });
}

describe("message holds API", () => {
  it("lists holds with the default and an explicit limit", async () => {
    for (const path of ["/api/message-holds", "/api/message-holds?limit=200"]) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(Array.isArray(((await response.json()) as { holds: unknown }).holds)).toBe(true);
    }
  });

  it("refuses a limit outside 1-200", async () => {
    for (const limit of ["0", "201", "1.5", "many"]) {
      await expectFail(call(`/api/message-holds?limit=${limit}`), 400, "limit must be 1-200");
    }
  });

  it("answers unknown hold routes with not found", async () => {
    const id = crypto.randomUUID();
    await expectFail(post("/api/message-holds", {}), 404, "not found");
    await expectFail(post(`/api/message-holds/${id}/cancel`, { expectedVersion: 0 }), 404, "not found");
    await expectFail(call(`/api/message-holds/${id}/release`), 404, "not found");
  });

  it("refuses an invalid hold id and an invalid expectedVersion", async () => {
    await expectFail(post("/api/message-holds/not-a-uuid/release", { expectedVersion: 0 }), 400, "invalid hold id");
    const path = `/api/message-holds/${crypto.randomUUID()}/release`;
    for (const body of ["not json", {}, { expectedVersion: "1" }, { expectedVersion: 1.5 }, { expectedVersion: -1 }]) {
      await expectFail(post(path, body), 400, "invalid expectedVersion");
    }
  });

  it("answers an unknown hold with 404", async () => {
    await expectFail(post(`/api/message-holds/${crypto.randomUUID()}/release`, { expectedVersion: 0 }), 404, "unknown hold");
  });
});

describe("operator API refusals", () => {
  it("refuses the reserved control-plane actor", async () => {
    await expectFail(call("/api/nodes", {}, CONTROL_PLANE_SESSION), 403, "reserved actor");
  });

  it("refuses an enrollment with an invalid body or ttlSeconds", async () => {
    await expectFail(post("/api/enrollments", "not json"), 400, "invalid body");
    await expectFail(post("/api/enrollments", { ttlSeconds: "60" }), 400, "invalid ttlSeconds");
  });

  it("refuses an invalid or unknown node id", async () => {
    await expectFail(call("/api/nodes/not-a-node"), 400, "invalid node id");
    await expectFail(call(`/api/nodes/${crypto.randomUUID()}`), 404, "unknown node");
  });

  it("refuses commands with an invalid body or for an unknown node", async () => {
    const unknown = crypto.randomUUID();
    await expectFail(post(`/api/nodes/${unknown}/commands`, "not json"), 400, "invalid body");
    await expectFail(post(`/api/nodes/${unknown}/commands`, { command: "node.status" }), 404, "unknown node");
  });

  it("answers an unsupported method on a node sub-resource with not found", async () => {
    const nodeId = await enroll(await newKey());
    await expectFail(call(`/api/nodes/${nodeId}/messages`), 404, "not found");
  });

  it("refuses task routes with an invalid limit, id, route or body", async () => {
    const unknown = crypto.randomUUID();
    await expectFail(call("/api/tasks?limit=0"), 400, "limit must be 1-200");
    await expectFail(call("/api/tasks/not-a-task"), 400, "invalid task id");
    await expectFail(call(`/api/tasks/${unknown}`), 404, "unknown task");
    await expectFail(post(`/api/tasks/${unknown}/restart`, {}), 404, "not found");
    await expectFail(post(`/api/tasks/${unknown}/stop`, "not json"), 400, "invalid body");
  });

  it("refuses a task without requirements when no node can run the default runtime", async () => {
    const response = await post("/api/tasks", { title: "Synthetic task", text: "synthetic text" });
    expect(response.status).toBe(409);
  });

  it("lists messages with the default limit", async () => {
    const response = await call("/api/messages");
    expect(response.status).toBe(200);
    expect(Array.isArray(((await response.json()) as { messages: unknown }).messages)).toBe(true);
  });
});
