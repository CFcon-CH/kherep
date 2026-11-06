// MCP registry audit for capability-check.mts: which servers are active for a
// workspace, which definitions exist host-wide, and whether any of them carries
// a credential inside argv. Split out for the 250-LOC ceiling (Golden Rule 6,
// OP-1121); the functions are the tested surface of the checker.

import path from "node:path";

import { field, isRecord } from "./shape.mts";

export interface SupplementalConfig {
  source: string;
  value: unknown;
}

export interface McpEntry {
  source: string;
  name: string;
  value: unknown;
}

function normalizedFsPath(value: unknown): string {
  return path.resolve(String(value || "")).replace(/\\/g, "/").replace(/(?<!\/)\/+$/, "").toLowerCase();
}

export function serverEntries(value: unknown): [string, unknown][] {
  const servers = field(value, "mcpServers");
  return isRecord(servers) ? Object.entries(servers) : [];
}

function projectConfigs(config: unknown): Record<string, unknown> {
  const projects = field(config, "projects");
  return isRecord(projects) ? projects : {};
}

export function activeMcpEntries(config: unknown, workspace: string, supplemental: SupplementalConfig[] = []): Map<string, unknown> {
  const entries = new Map(serverEntries(config));
  const wanted = normalizedFsPath(workspace);
  for (const [projectPath, projectConfig] of Object.entries(projectConfigs(config))) {
    if (normalizedFsPath(projectPath) !== wanted) continue;
    serverEntries(projectConfig).forEach(([name, value]) => entries.set(name, value));
  }
  supplemental.forEach(({ value }) => serverEntries(value).forEach(([name, server]) => entries.set(name, server)));
  return entries;
}

export function allMcpEntries(config: unknown, supplemental: SupplementalConfig[] = []): McpEntry[] {
  const entries: McpEntry[] = serverEntries(config).map(([name, value]) => ({ source: "user", name, value }));
  for (const projectConfig of Object.values(projectConfigs(config))) {
    serverEntries(projectConfig).forEach(([name, value]) => entries.push({ source: "registry-project", name, value }));
  }
  for (const item of supplemental) {
    serverEntries(item.value).forEach(([name, value]) => entries.push({ source: item.source, name, value }));
  }
  return entries;
}

export function hasCredentialArg(server: unknown): boolean {
  if (!isRecord(server)) return false;
  if (Object.prototype.hasOwnProperty.call(server, "command") && typeof server.command !== "string") return true;
  if (Object.prototype.hasOwnProperty.call(server, "args") && !Array.isArray(server.args)) return true;
  const args: unknown[] = Array.isArray(server.args) ? server.args : [];
  if (args.some((value) => typeof value !== "string")) return true;
  const values = [server.command, ...args].filter((value): value is string => typeof value === "string");
  const credentialAssignment = /(?:^|[^A-Za-z0-9])(?:authorization|x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|oauth2[-_]?bearer|password|secret|token)\s*[:=]/i;
  const credentialFlag = /--(?:oauth2[-_]?bearer|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|password|secret|token)(?:[=\s]|$)/i;
  const urlUserInfo = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s@]+@/;
  const jwt = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
  return values.some((value) => credentialAssignment.test(value) || credentialFlag.test(value)
    || urlUserInfo.test(value) || jwt.test(value));
}
