// OP-1137. Scope- und Pfad-Helfer für die Hooks, ab dieser Welle TypeScript.
//
// Der Vertrag ist unverändert: alles hier arbeitet auf Zeichenketten statt auf
// node:path, weil ein Hook unter Windows mit POSIX-Payloads getestet wird und
// umgekehrt.

// Eine Umgebung ist hier nur ein Lesezugriff auf Namen. process.env passt
// darauf, ein Test-Literal wie { KHEREP_WORKSPACE: "..." } ebenso.
export type EnvLike = Record<string, string | undefined>;

// Aus einem Hook-Payload liest dieses Modul genau ein Feld. Der Rest bleibt
// bewusst unbetrachtet: ein Transkript-Slug ist niemals Scope.
export interface ScopePayload {
  cwd?: unknown;
  [key: string]: unknown;
}

export function normalizePathLike(value: unknown): string {
  if (typeof value !== "string") return "";
  let raw = value.trim().replace(/^file:\/{2,}/i, "/").replace(/\\/g, "/");
  if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
  const drive = raw.match(/^[A-Za-z]:\//);
  const absolute = raw.startsWith("/");
  const prefix = drive ? raw.slice(0, 3) : absolute ? "/" : "";
  if (drive) raw = raw.slice(3);
  else if (absolute) raw = raw.slice(1);

  const parts: string[] = [];
  for (const part of raw.split(/\/+/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!prefix) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  const joined = `${prefix}${parts.join("/")}`;
  return joined.length > 1 ? joined.replace(/(?<!\/)\/+$/, "") : joined;
}

export function isWithinPath(candidate: unknown, root: unknown): boolean {
  const child = normalizePathLike(candidate).toLowerCase();
  const parent = normalizePathLike(root).toLowerCase();
  return Boolean(parent && (child === parent || child.startsWith(`${parent}/`)));
}

export function productEnv(env: EnvLike, suffix: string): string | undefined {
  const canonical = `KHEREP_${suffix}`;
  return Object.prototype.hasOwnProperty.call(env, canonical) ? env[canonical] : undefined;
}

export function configuredWorkspace(env: EnvLike = process.env): string {
  const value = productEnv(env, "WORKSPACE");
  if (Object.hasOwn(env, "KHEREP_WORKSPACE")) return normalizePathLike(value || "");
  const userHome = env.USERPROFILE || env.HOME || "";
  return normalizePathLike(joinPathLike(userHome, "Kherep"));
}

export function workspaceForPayload(payload: ScopePayload | null | undefined = {}, env: EnvLike = process.env): string {
  const cwd = normalizePathLike(payload?.cwd);
  const configured = configuredWorkspace(env);
  if (cwd) {
    if (configured && isWithinPath(cwd, configured)) return configured;
    return "";
  }
  // A deliberately supplied KHEREP_WORKSPACE is sufficient when older hook
  // payloads omit cwd. Transcript slugs alone are never treated as scope.
  return Object.hasOwn(env, "KHEREP_WORKSPACE") ? configured : "";
}

export function isKherepScope(payload: ScopePayload | null | undefined, env: EnvLike = process.env): boolean {
  return Boolean(workspaceForPayload(payload, env));
}

export function joinPathLike(root: unknown, suffix: unknown): string {
  const base = normalizePathLike(root);
  const tail = normalizePathLike(suffix).replace(/^\/+/, "");
  return base ? `${base}/${tail}` : tail;
}
