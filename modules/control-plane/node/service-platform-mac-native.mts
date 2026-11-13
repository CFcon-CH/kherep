import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface MacCommandResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type MacCommand = (
  file: string, args: string[], timeout?: number, env?: NodeJS.ProcessEnv,
) => MacCommandResult;

export const runMacCommand: MacCommand = (file, args, timeout = 15_000, env = process.env) => {
  const result = spawnSync(file, args, {
    encoding: "utf8", env, windowsHide: true, timeout, stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
};

export const PID_PATH_JXA = "ObjC.import('Foundation');ObjC.bindFunction('proc_pidpath',['int',['int','void *','unsigned int']]);"
  + "function run(argv){var b=$.NSMutableData.dataWithLength(4096);var n=$.proc_pidpath(Number(argv[0]),b.mutableBytes,4096);"
  + "if(!(n>0&&n<4096))throw Error('path unavailable');b.length=n;"
  + "return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(b,$.NSUTF8StringEncoding));}";
export const MAC_EXECUTABLE_PROBE = "/usr/bin/osascript";

export function macAclAbsent(output: string): boolean {
  const lines = output.split(/\r?\n/u).filter(line => line.length > 0);
  if (!lines.length) throw new Error("LaunchAgent ACL inventory is empty");
  return !lines.some(line => /^\s*\d+:\s/u.test(line));
}

export function macFileSecurity(file: string, run: MacCommand): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("LaunchAgent definition is not a regular file");
  const inventory = run("/bin/ls", ["-lde", file], 15_000, { ...process.env, LANG: "C", LC_ALL: "C" });
  if (inventory.status !== 0) throw new Error("LaunchAgent ACL inventory is unavailable");
  if (!macAclAbsent(inventory.stdout)) throw new Error("LaunchAgent has an extended ACL");
  return Buffer.from(JSON.stringify({ mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, acl: "absent" }));
}

export function readMacPlist(run: MacCommand, file: string): Record<string, unknown> {
  const converted = run("plutil", ["-convert", "json", "-o", "-", "--", file]);
  if (converted.status !== 0 || converted.stderr !== "") throw new Error("LaunchAgent property list has unsupported values");
  const parsed: unknown = JSON.parse(converted.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LaunchAgent property list has unsupported values");
  return parsed as Record<string, unknown>;
}

export type MacLaunchAgentProbe = { kind: "absent" } | {
  kind: "loaded";
  origin: string;
  program: string;
  arguments: string[];
  workingDirectory?: string;
  stdoutPath?: string;
  stderrPath?: string;
  pid?: number;
};

const unavailable = (): never => { throw new Error("launchd loaded service identity is unavailable"); };

function oneField(lines: string[], name: string): string {
  const prefix = `\t${name} = `;
  const values = lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length));
  if (values.length !== 1 || !values[0] || values[0].includes("\0")) unavailable();
  return values[0];
}

function optionalPathField(lines: string[], name: string): string | undefined {
  const prefix = `\t${name} = `;
  const values = lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length));
  if (values.length > 1) unavailable();
  if (!values.length) return undefined;
  const value = values[0];
  if (!value || !path.isAbsolute(value) || value.includes("\0")) unavailable();
  return value;
}

function argumentsBlock(lines: string[]): string[] {
  const starts = lines.flatMap((line, index) => line === "\targuments = {" ? [index] : []);
  if (starts.length !== 1) unavailable();
  const end = lines.indexOf("\t}", starts[0] + 1);
  if (end < 0) unavailable();
  const values = lines.slice(starts[0] + 1, end);
  if (!values.length || values.some(line => !line.startsWith("\t\t") || line.length === 2 || line.includes("\0"))) unavailable();
  return values.map(line => line.slice(2));
}

function attestEnvironment(lines: string[]): void {
  for (const name of ["inherited environment", "default environment", "environment"]) {
    const header = `\t${name} = {`;
    const starts = lines.flatMap((line, index) => line === header ? [index] : []);
    if (starts.length !== 1) unavailable();
    const end = lines.indexOf("\t}", starts[0] + 1);
    if (end < 0) unavailable();
    for (const line of lines.slice(starts[0] + 1, end)) {
      const entry = /^\t\t([A-Za-z0-9_]+)\s*=>\s*((?:\S.*)?)$/u.exec(line);
      if (!entry) throw new Error("launchd loaded service identity is unavailable");
      if (/^(?:NODE_OPTIONS|NODE_PATH)$/iu.test(entry[1])) {
        throw new Error("launchd loaded service has execution-affecting environment");
      }
    }
  }
}

export function parseLaunchctlPrint(stdout: string, target: string): MacLaunchAgentProbe {
  if (stdout.includes("\0") || !stdout.endsWith("}\n")) unavailable();
  const lines = stdout.slice(0, -1).split("\n");
  if (lines[0] !== `${target} = {` || lines.at(-1) !== "}") unavailable();
  const origin = oneField(lines, "path");
  const type = oneField(lines, "type");
  oneField(lines, "state");
  const program = oneField(lines, "program");
  if (type !== "LaunchAgent" || !path.isAbsolute(origin) || !path.isAbsolute(program)) unavailable();
  const arguments_ = argumentsBlock(lines);
  attestEnvironment(lines);
  const workingDirectory = optionalPathField(lines, "working directory");
  const stdoutPath = optionalPathField(lines, "stdout path");
  const stderrPath = optionalPathField(lines, "stderr path");
  const pidValues = lines.filter(line => line.startsWith("\tpid = ")).map(line => line.slice(7));
  if (pidValues.length > 1 || (pidValues[0] && !/^[1-9]\d*$/u.test(pidValues[0]))) unavailable();
  const pid = pidValues[0] ? Number(pidValues[0]) : undefined;
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) unavailable();
  return { kind: "loaded", origin, program, arguments: arguments_,
    ...(workingDirectory ? { workingDirectory } : {}), ...(stdoutPath ? { stdoutPath } : {}),
    ...(stderrPath ? { stderrPath } : {}), ...(pid ? { pid } : {}) };
}

export function probeMacLaunchAgent(run: MacCommand, uid: number, label: string): MacLaunchAgentProbe {
  const target = `gui/${uid}/${label}`;
  const observed = run("launchctl", ["print", target], 15_000, { ...process.env, LANG: "C", LC_ALL: "C" });
  const absent = `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}\n`;
  if (!observed.error && observed.status === 113 && observed.stdout === "" && observed.stderr === absent) {
    const domain = `gui/${uid}`;
    const context = run("launchctl", ["print", domain], 15_000, { ...process.env, LANG: "C", LC_ALL: "C" });
    if (context.error || context.status !== 0 || context.stderr !== "" || context.stdout.includes("\0")
      || !context.stdout.startsWith(`${domain} = {\n`) || !context.stdout.endsWith("}\n")) unavailable();
    return { kind: "absent" };
  }
  if (observed.error || observed.status !== 0 || observed.stderr !== "") unavailable();
  return parseLaunchctlPrint(observed.stdout, target);
}

export function sameMacLaunchAgent(left: MacLaunchAgentProbe, right: MacLaunchAgentProbe): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  return left.origin === right.origin && left.program === right.program && left.pid === right.pid
    && left.workingDirectory === right.workingDirectory && left.stdoutPath === right.stdoutPath
    && left.stderrPath === right.stderrPath
    && left.arguments.length === right.arguments.length
    && left.arguments.every((value, index) => value === right.arguments[index]);
}

export function attestMacLaunchAgent(
  probe: MacLaunchAgentProbe, file: string, configured?: Record<string, unknown>, expectedPid?: number,
): void {
  if (probe.kind === "absent") return;
  if (path.resolve(probe.origin) !== path.resolve(file)) throw new Error("LaunchAgent loaded origin does not match selected definition");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error("LaunchAgent loaded definition is unavailable");
  if (path.resolve(probe.origin) !== path.resolve(fs.realpathSync.native(file))) throw new Error("LaunchAgent loaded origin is not canonical");
  if (expectedPid !== undefined && probe.pid !== expectedPid) throw new Error("LaunchAgent loaded pid does not match selected process");
  if (!configured) return;
  const args = configured.ProgramArguments;
  const program = typeof configured.Program === "string" ? configured.Program : Array.isArray(args) ? args[0] : undefined;
  if (typeof program !== "string" || !Array.isArray(args) || args.some(value => typeof value !== "string")
    || probe.program !== program || JSON.stringify(probe.arguments) !== JSON.stringify(args)) {
    throw new Error("LaunchAgent loaded definition does not match selected definition");
  }
  const paths: Array<[keyof typeof probe, string]> = [
    ["workingDirectory", "WorkingDirectory"], ["stdoutPath", "StandardOutPath"], ["stderrPath", "StandardErrorPath"],
  ];
  for (const [observed, key] of paths) {
    const expected = configured[key];
    const actual = probe[observed];
    if ((expected === undefined) !== (actual === undefined)
      || (expected !== undefined && (typeof expected !== "string" || !path.isAbsolute(expected)
        || expected.includes("\0") || actual !== expected))) {
      throw new Error("LaunchAgent loaded definition does not match selected definition");
    }
  }
}

export function attestMacProcessAbsence(run: MacCommand, commands: string[]): void {
  const inventory = run("ps", ["-ww", "-axo", "pid=,uid=,command="], 15_000,
    { ...process.env, LANG: "C", LC_ALL: "C" });
  if (inventory.error || inventory.status !== 0 || inventory.stderr !== "" || inventory.stdout.includes("\0")) {
    throw new Error("managed daemon process inventory is unavailable");
  }
  const lines = inventory.stdout.split(/\r?\n/u).filter(Boolean);
  if (!lines.length) throw new Error("managed daemon process inventory is unavailable");
  for (const line of lines) {
    const head = /^\s*([1-9]\d*)\s+(\d+)\s/u.exec(line);
    // The command is the rest without leading whitespace; a rest of whitespace only keeps its last character, as (.+)$ did.
    const rest = head ? line.slice(head[0].length) : "", command = rest.trimStart() || rest.slice(-1);
    if (!head || command === "" || /[\n\r\u2028\u2029]/u.test(command)
      || !Number.isSafeInteger(Number(head[1])) || !Number.isSafeInteger(Number(head[2]))) {
      throw new Error("managed daemon process inventory is unavailable");
    }
    if (commands.includes(command)) throw new Error("managed daemon process remains without a loaded LaunchAgent");
  }
}
