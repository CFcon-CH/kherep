import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { verifyIntent, type NativeMeta, type ProbeResult } from "./binding.mts";

function nativeMeta(value: unknown): NativeMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const meta = value as Record<string, unknown>;
  return {
    ...(typeof meta.sessionId === "string" ? { sessionId: meta.sessionId } : {}),
    ...(typeof meta.threadId === "string" ? { threadId: meta.threadId } : {}),
    ...(typeof meta.callId === "string" ? { callId: meta.callId } : {}),
  };
}

function toolResult(result: ProbeResult, meta: NativeMeta = {}) {
  const value = result.ok ? {
    ...result.receipt,
    threadMatchesHookSession: typeof meta.threadId === "string" && meta.threadId === meta.sessionId,
  } : { code: result.code };
  const structuredContent: Record<string, unknown> = { ...value };
  return {
    ...(result.ok ? {} : { isError: true }),
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  };
}

export function createProbeServer(stateDir: string | undefined): McpServer {
  const server = new McpServer({ name: "kherep-binding-probe", version: "0.0.0" });
  server.registerTool("binding_probe", {
    description: "Read-only synthetic client identity binding probe",
    inputSchema: {
      requestId: z.string().optional(),
      syntheticNonce: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, extra) => {
    if (!stateDir) return toolResult({ ok: false, code: "storage_error" });
    if (!args.requestId) return toolResult({ ok: false, code: "invalid_input" });
    const meta = nativeMeta(extra._meta);
    return toolResult(verifyIntent(stateDir, { requestId: args.requestId, syntheticNonce: args.syntheticNonce },
      meta), meta);
  });
  return server;
}

function stateDirectory(args: string[]): string | undefined {
  return args.length === 2 && args[0] === "--state-dir" && args[1].length <= 4_096
    && path.isAbsolute(args[1]) ? args[1] : undefined;
}

async function main(): Promise<void> {
  const server = createProbeServer(stateDirectory(process.argv.slice(2)));
  await server.connect(new StdioServerTransport(undefined, undefined, { maxBufferSize: 64 * 1024 }));
}

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
  main().catch(() => {
    process.stderr.write("binding_probe_server_error\n");
    process.exitCode = 1;
  });
}