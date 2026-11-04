import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";
import { validRequest, MAX_BYTES, failure } from "../session-node-protocol.mts";
import { HostProcess, bounded } from "./host-process.mts";
export default async function setup(project: TestProject) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-node-test-"));
  const token = randomBytes(24).toString("hex");
  const cases = new Map<string, { process: HostProcess; seen: Set<number> }>();
  let stopping = false;
  const server = http.createServer(async (request, response) => {
    try {
      if (stopping || request.method !== "POST" || request.url !== "/v1" || request.headers["x-test-token"] !== token
        || !request.headers["content-type"]?.startsWith("application/json")) throw Error("invalid harness request");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > MAX_BYTES) throw Error("harness request bound"); chunks.push(chunk); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!validRequest(body)) throw Error("invalid harness command");
      const command = body.command;
      let result: unknown;
      if (command.op === "create") {
        if (body.caseId !== null || cases.size >= 8) throw Error("invalid case creation");
        const id = randomUUID(), child = new HostProcess(project.config.root, root, command.runtime);
        cases.set(id, { process: child, seen: new Set([body.id]) });
        try { await bounded(child.ready, 10_000, "native import deadline"); }
        catch (error) {
          let cleanup: unknown; try { await child.close(); cases.delete(id); } catch (e) { cleanup = e; }
          if (cleanup) throw new AggregateError([error, cleanup], "native startup and cleanup failed", { cause: error });
          throw error;
        }
        result = { caseId: id };
      } else {
        const entry = body.caseId ? cases.get(body.caseId) : null;
        if (!entry || entry.seen.has(body.id) || entry.seen.size >= 4096) throw Error("unknown case or duplicate command");
        entry.seen.add(body.id);
        if (command.op === "close") { await entry.process.close(); cases.delete(body.caseId!); result = null; }
        else result = await entry.process.request(command);
      }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ version: 1, id: body.id, result }));
    } catch (error) {
      response.statusCode = 500; response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: failure(error) }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw Error("missing loopback listener");
    project.provide("nodeHarnessPort", address.port); project.provide("nodeHarnessToken", token);
  } catch (error) { server.close(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
  return async () => {
    stopping = true;
    const results = await Promise.allSettled([...cases.values()].map(entry => entry.process.close()));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason as unknown);
    const closed = new Promise<void>(resolve => { server.close(() => resolve()); });
    try { await bounded(closed, 1000, "HTTP graceful close deadline"); }
    catch { server.closeAllConnections(); try { await bounded(closed, 1000, "HTTP final close deadline"); } catch (e) { errors.push(e); } }
    if (errors.length) throw new AggregateError(errors, "native test harness teardown failed");
    fs.rmSync(root, { recursive: true, force: true });
  };
}
