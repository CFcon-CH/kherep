import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { failure, isObject, type ChildCommand, type Runtime } from "../session-node-protocol.mts";
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
export function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(label)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
export class HostProcess {
  readonly root: string;
  readonly child: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private closing = false;
  private terminal: Error | null = null;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  private exitResolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { this.exitResolve = resolve; });
  constructor(workerRoot: string, generatedRoot: string, runtime: Runtime) {
    this.root = fs.mkdtempSync(path.join(generatedRoot, "case-"));
    const dirs = Object.fromEntries(["home", "tmp", "config", "cache", "data", "codex"].map(name => {
      const dir = path.join(this.root, name); fs.mkdirSync(dir, { mode: 0o700 }); return [name, dir];
    }));
    const env: NodeJS.ProcessEnv = { HOME: dirs.home, USERPROFILE: dirs.home, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
      XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_DATA_HOME: dirs.data, CODEX_HOME: dirs.codex };
    if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    this.child = fork(path.join(workerRoot, "test/session-node-host/child.mts"), [this.root, runtime], {
      execPath: process.execPath, execArgv: [], env, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: false,
    });
    let diagnosticBytes = 0;
    const diagnostic = (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 8192) this.fail(Error("child diagnostics exceeded bound"));
      else process.stderr.write(chunk);
    };
    this.child.stdout?.on("data", diagnostic); this.child.stderr?.on("data", diagnostic);
    this.child.on("error", error => this.fail(error));
    this.child.on("disconnect", () => { if (!this.closing) this.fail(Error("native child IPC disconnected")); });
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.fail(Error(`native child exited (${code ?? signal})`));
      this.exitResolve({ code, signal });
    });
    this.child.on("message", (value: unknown) => {
      if (!isObject(value)) { this.fail(Error("invalid child response")); return; }
      if (value.ready === true) { this.readyResolve(); return; }
      const id = Number(value.id), pending = this.pending.get(id);
      if (!Number.isSafeInteger(id) || !pending) { this.fail(Error("uncorrelated child response")); return; }
      this.pending.delete(id); clearTimeout(pending.timer);
      if (value.error) pending.reject(Object.assign(Error(isObject(value.error) && typeof value.error.message === "string" ? value.error.message : "native child operation failed"), { cause: value.error }));
      else pending.resolve(value.result);
    });
    if (!this.child.pid || this.child.pid === process.pid || this.child.spawnfile !== process.execPath) this.fail(Error("native child ownership mismatch"));
  }
  private fail(error: Error): void {
    if (!this.closing) this.terminal ??= error;
    this.readyReject(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  request(command: ChildCommand): Promise<unknown> {
    if (this.closed || this.terminal || this.pending.size >= 256) return Promise.reject(this.terminal ?? Error("native child unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(Error(`native command deadline: ${command.op}`)); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, command }, error => { if (error) this.fail(error); });
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    let forced = false;
    const errors: unknown[] = this.terminal ? [this.terminal] : [];
    if (!this.closed) {
      try { await this.request({ op: "shutdown" }); await bounded(this.exit, 2000, "child exit deadline"); }
      catch (error) {
        errors.push(error); forced = true; this.child.kill();
        try { await bounded(this.exit, 2000, "owned child kill deadline"); } catch (e) { errors.push(e); }
      }
    }
    const result = this.closed ? await this.exit : null;
    const receipt = { closed: this.closed, result, forced, pending: this.pending.size, errors: errors.map(failure) };
    fs.writeFileSync(path.join(this.root, "lifecycle.json"), JSON.stringify(receipt));
    if (!this.closed || result?.code !== 0 || forced || this.pending.size || errors.length) throw Error("native child cleanup failed", { cause: receipt });
  }
}
