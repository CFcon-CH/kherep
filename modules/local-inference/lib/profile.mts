import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BackendSpec, Env, LocalInferenceConfig, Profile } from "./config.mts";

function productEnv(env: Env, suffix: string): string | undefined {
  return env[`KHEREP_${suffix}`];
}

export interface PortablePaths {
  home: string;
  workspace: string;
  credentials: string;
  output: string;
}

export function within(file: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function detectProfile(env: Env = process.env, platform: string = process.platform): Profile {
  const configured = productEnv(env, "PROFILE");
  const profile = configured ?? (platform === "darwin" ? "mac" : "win");
  if (profile !== "win" && profile !== "mac") throw new Error("KHEREP_PROFILE must be win or mac");
  return profile;
}

// Copy of lib/workspace-path.mts (issue #75): this lib is projected on its own
// and cannot import from the repository root. lib/workspace-path.test.mts
// asserts that both behave the same.
export function nativeWorkspacePath(value: string, platform: string = process.platform): string {
  if (platform !== "win32") return value;
  const drive = value.match(/^\/([A-Za-z])(\/.*)?$/);
  return drive ? `${drive[1].toUpperCase()}:${(drive[2] || "/").replace(/\//g, "\\")}` : value;
}

export function portablePaths(profile: Profile, env: Env = process.env): PortablePaths {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const pathApi = profile === "mac" ? path.posix : path;
  const workspaceValue = productEnv(env, "WORKSPACE");
  if (workspaceValue === "") throw new Error("KHEREP_WORKSPACE must not be empty");
  const workspace = pathApi.resolve(
    workspaceValue === undefined ? pathApi.join(home, "Kherep") : nativeWorkspacePath(workspaceValue),
  );
  const credentialsValue = productEnv(env, "CREDENTIALS_ROOT");
  if (credentialsValue === "") throw new Error("KHEREP_CREDENTIALS_ROOT must not be empty");
  const credentials = pathApi.resolve(credentialsValue ?? pathApi.join(home, ".kherep", "credentials"));
  const outputValue = productEnv(env, "LOCAL_OUTPUT_ROOT");
  if (outputValue === "") throw new Error("KHEREP_LOCAL_OUTPUT_ROOT must not be empty");
  const output = pathApi.resolve(outputValue ?? pathApi.join(workspace, "analysis", "local-inference"));
  return { home, workspace, credentials, output };
}

export function configuredRoots(profile: Profile, env: Env = process.env): string[] {
  const raw = productEnv(env, "LOCAL_INPUT_ROOTS");
  if (raw) return raw.split(profile === "mac" ? ":" : ";").filter(Boolean);
  const locations = portablePaths(profile, env);
  return [locations.workspace, locations.credentials];
}

export function endpointUrl(endpoint: string, route: string): string {
  return `${endpoint.replace(/(?<!\/)\/+$/, "")}/${String(route).replace(/^\/+/, "")}`;
}

export function assertLoopback(endpoint: string): void {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Local inference endpoints must use HTTP(S)");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Local inference HTTP endpoints must be loopback; use SSH for a remote backend");
  }
}

export function assertSshHost(value: unknown): void {
  const host = String(value || "");
  if (host.length > 255
      || !/^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:]+\])$/.test(host)) {
    throw new Error("SSH host must be a plain [user@]host value, not an option or shell expression");
  }
}

export function resolveSpec(config: LocalInferenceConfig, profile: Profile, backend: string, env: Env = process.env): BackendSpec {
  if (profile === "mac" && backend === "win") {
    throw new Error("Mac-to-Windows inference route is unsupported");
  }
  const base = config.backends && config.backends[backend];
  const route = config.profiles && config.profiles[profile] && config.profiles[profile].backends
    && config.profiles[profile].backends[backend];
  if (!base || !route) throw new Error(`Backend '${backend}' has no '${profile}' host route in local inference config`);
  const spec: BackendSpec = { ...base, ...route };
  const macSshHost = productEnv(env, "MAC_SSH_HOST");
  if (backend === "mac" && macSshHost) spec.sshHost = macSshHost;
  if (!["local", "ssh"].includes(spec.transport)) throw new Error(`Invalid transport for ${profile}->${backend}`);
  if (spec.transport === "ssh" && !spec.sshHost) throw new Error(`SSH host missing for ${profile}->${backend}`);
  if (spec.transport === "ssh") assertSshHost(spec.sshHost);
  assertLoopback(spec.endpoint);
  return spec;
}
