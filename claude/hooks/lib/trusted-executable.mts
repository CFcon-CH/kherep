import fs from "node:fs";
import path from "node:path";

export interface ExecutableLookup {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  isExecutable?: (file: string) => boolean;
  realpath?: (file: string) => string;
  preferNative?: boolean;
}

// win32.isAbsolute also accepts drive-relative roots such as \tools.
export function fullyQualifiedPath(file: string, platform: string): boolean {
  return platform === "win32"
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(file)
    : path.posix.isAbsolute(file);
}

function environment(env: NodeJS.ProcessEnv, key: string, windows: boolean): string | undefined {
  if (!windows) return env[key];
  // Node forwards the first lexicographic spelling of a Windows env key.
  const name = Object.keys(env).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    .find((entry) => entry.toUpperCase() === key);
  return name === undefined ? undefined : env[name];
}

function executable(file: string, windows: boolean): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, windows ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** Resolve only explicitly absolute PATH directories. Never asks a shell/where/which. */
export function findTrustedExecutable(name: string, options: ExecutableLookup = {}): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const normalize = (value: string) => {
    const full = paths.normalize(value);
    let end = full.length;
    while (end > 0 && (full[end - 1] === "/" || (windows && full[end - 1] === "\\"))) end--;
    const normalized = full.slice(0, end);
    return windows ? normalized.toLowerCase() : normalized;
  };
  const canonical = (value: string) => {
    try { return normalize((options.realpath ?? fs.realpathSync.native)(value)); }
    catch { return normalize(value); }
  };
  // A removed working directory makes process.cwd() throw; there is then nothing to exclude.
  let current = options.cwd;
  if (current === undefined) try { current = process.cwd(); } catch { /* removed working directory */ }
  const cwd = current === undefined ? undefined : canonical(current);
  const dirs = (environment(env, "PATH", windows) ?? "").split(windows ? ";" : ":")
    .map((entry) => windows && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry)
    .filter((entry) => fullyQualifiedPath(entry, platform) && canonical(entry) !== cwd);
  const extensions = windows && !paths.extname(name)
    ? [...new Set((environment(env, "PATHEXT", true) ?? ".COM;.EXE;.BAT;.CMD").split(";")
      .filter((entry) => /^\.[A-Za-z0-9]+$/.test(entry)).map((entry) => entry.toLowerCase()))]
    : [""];
  const groups = options.preferNative !== false && windows
    ? [extensions.filter((ext) => [".exe", ".com"].includes(ext))
      .sort((a, b) => Number(b === ".exe") - Number(a === ".exe")),
    extensions.filter((ext) => ![".exe", ".com"].includes(ext))]
    : [extensions];
  const check = options.isExecutable ?? ((file: string) => executable(file, windows));
  for (const suffixes of groups) for (const dir of dirs) for (const suffix of suffixes) {
    const file = paths.join(dir, name + suffix);
    if (check(file)) return file;
  }
  return null;
}

export function requireTrustedExecutable(name: string, options: ExecutableLookup = {}): string {
  const command = findTrustedExecutable(name, options);
  if (command) return command;
  throw Object.assign(new Error(`spawn ${name} ENOENT: no executable in an absolute PATH directory`), { code: "ENOENT" });
}
