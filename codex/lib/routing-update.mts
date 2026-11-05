import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { renderIntercom } from "../../bootstrap/render-intercom.mts";
import { launcherCommand } from "../../modules/control-plane/node/launcher.mts";
import { InstallTransaction } from "./install-transaction.mts";

interface Binding { configRoot: string; exampleTarget: string; platform: NodeJS.Platform }
interface UpdateOptions extends Omit<Binding, "platform"> {
  codexHome: string;
  platform?: NodeJS.Platform;
  mode: "check" | "apply";
  onWrite?: (file: string) => void;
  beforeWrite?: () => void;
}
interface Result { status: "ready" | "unchanged" | "applied" | "rolled-back"; backupId?: string }
interface Receipt {
  version: number; backupId: string; status: string; predecessorRevision: string;
  routingSourceSha256: string; beforeSha256: string; afterSha256: string; backupSha256: string; binding: Binding;
}
const SOURCE = path.resolve(import.meta.dirname, "../ROUTING.md");
const PREDECESSOR = path.resolve(import.meta.dirname, "../parity/routing-predecessor.json");
const REVISION = "kherep@2b592140fd25e5e1f49dc3547ca3a798ef418721";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}$/;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const same = (a: Buffer, b: Buffer) => a.equals(b);

// Inspect only each fixed path's ancestors. lstat rejects symlinks and Windows
// junctions before realpath checks containment; no home directory is enumerated.
function safePath(file: string, kind: "file" | "directory", optional = false): void {
  if (!path.isAbsolute(file)) throw new Error("routing path must be absolute");
  const resolved = path.resolve(file);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) {
      if (optional) return;
      throw new Error("routing path missing");
    }
    if (stat.isSymbolicLink() || path.relative(cursor, fs.realpathSync(cursor)) !== "") {
      throw new Error("routing path redirected");
    }
    const expected = i === parts.length - 1 ? kind : "directory";
    if (expected === "file" ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error("routing path has wrong type");
    }
  }
}
function paths(codexHome: string) {
  if (!path.isAbsolute(codexHome)) throw new Error("Codex home must be absolute");
  const home = path.resolve(codexHome);
  const target = path.join(home, "orchestra/ROUTING.md");
  const backups = path.join(home, "backups/kherep-routing");
  safePath(home, "directory");
  safePath(target, "file");
  safePath(backups, "directory", true);
  return { home, target, backups };
}
function bindingFor(input: Omit<Binding, "platform"> & { platform?: NodeJS.Platform }): Binding {
  const platform = input.platform ?? process.platform;
  if (!["win32", "darwin", "linux"].includes(platform) || typeof input.exampleTarget !== "string"
    || !/^[\w.-]{1,64}\/[\w.-]{1,64}$/.test(input.exampleTarget)) {
    throw new Error("invalid public render binding");
  }
  launcherCommand(input.configRoot, platform);
  return { configRoot: input.configRoot, exampleTarget: input.exampleTarget, platform };
}
function sources(binding: Binding) {
  const pinned = JSON.parse(fs.readFileSync(PREDECESSOR, "utf8")) as { revision: string; sha256: string; content: string };
  if (pinned.revision !== REVISION || typeof pinned.content !== "string" || hash(pinned.content) !== pinned.sha256) {
    throw new Error("invalid routing predecessor source");
  }
  const source = fs.readFileSync(SOURCE, "utf8");
  const render = (value: string) => Buffer.from(renderIntercom(value, { command: launcherCommand(binding.configRoot, binding.platform), exampleTarget: binding.exampleTarget }));
  return { before: render(pinned.content), after: render(source), sourceSha256: hash(source) };
}
function requireBytes(file: string, expected: Buffer): void {
  safePath(file, "file");
  if (!same(fs.readFileSync(file), expected)) throw new Error("routing bytes changed or evidence corrupted");
}

export function updateRouting(options: UpdateOptions): Result {
  if (options.mode !== "check" && options.mode !== "apply") throw new Error("invalid routing mode");
  const binding = bindingFor(options);
  const source = sources(binding);
  const location = paths(options.codexHome);
  const actual = fs.readFileSync(location.target);
  if (same(actual, source.after)) return { status: "unchanged" };
  if (!same(actual, source.before)) throw new Error("unrecognized routing bytes");
  if (options.mode === "check") return { status: "ready" };
  const backupId = `${randomUUID()}-${hash(JSON.stringify(binding))}`;
  const dir = path.join(location.backups, backupId);
  // Recheck after the final pre-write boundary and before the transaction's
  // constructor (which creates a directory). Unknown drift makes zero writes.
  options.beforeWrite?.();
  paths(options.codexHome);
  requireBytes(location.target, actual);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })) throw new Error("routing backup already exists");
  const transaction = new InstallTransaction(location.home, dir, options.onWrite ?? null);
  try {
    transaction.stage(location.target);
    const backup = path.join(dir, "orchestra/ROUTING.md");
    requireBytes(backup, actual);
    requireBytes(location.target, actual);
    transaction.writeFile(location.target, source.after.toString("utf8"));
    requireBytes(location.target, source.after);
    const receipt: Receipt = {
      version: 1,
      backupId,
      status: "applied",
      predecessorRevision: REVISION,
      routingSourceSha256: source.sourceSha256,
      beforeSha256: hash(actual),
      afterSha256: hash(source.after),
      backupSha256: hash(fs.readFileSync(backup)),
      binding,
    };
    const receiptFile = path.join(dir, "receipt.json");
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    transaction.writeFile(receiptFile, receiptBytes.toString("utf8"));
    requireBytes(receiptFile, receiptBytes);
    requireBytes(backup, actual);
    requireBytes(location.target, source.after);
    return { status: "applied", backupId };
  } catch (error) {
    transaction.rollback();
    requireBytes(location.target, actual);
    throw error;
  }
}

export function rollbackRouting(options: { codexHome: string; backupId: string }): Result {
  if (!ID.test(options.backupId)) throw new Error("invalid routing backup id");
  const location = paths(options.codexHome);
  const dir = path.join(location.backups, options.backupId);
  const receiptFile = path.join(dir, "receipt.json");
  const backup = path.join(dir, "orchestra/ROUTING.md");
  safePath(receiptFile, "file");
  safePath(backup, "file");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Receipt;
  if (receipt.version !== 1 || receipt.status !== "applied" || receipt.backupId !== options.backupId || receipt.predecessorRevision !== REVISION
    || !receipt.binding || Object.keys(receipt.binding).sort((left, right) => Number(left > right) - Number(left < right)).join() !== "configRoot,exampleTarget,platform") {
    throw new Error("invalid routing receipt");
  }
  const binding = bindingFor(receipt.binding);
  if (!options.backupId.endsWith(`-${hash(JSON.stringify(binding))}`)) throw new Error("routing receipt binding changed");
  const source = sources(binding);
  if (receipt.routingSourceSha256 !== source.sourceSha256 || receipt.beforeSha256 !== hash(source.before)
    || receipt.backupSha256 !== receipt.beforeSha256 || receipt.afterSha256 !== hash(source.after)) {
    throw new Error("invalid routing receipt digests");
  }
  requireBytes(backup, source.before);
  const actual = fs.readFileSync(location.target);
  if (same(actual, source.before)) return { status: "unchanged", backupId: options.backupId };
  if (!same(actual, source.after)) throw new Error("routing changed since update");
  // The immutable backup and receipt stay available for audit and repeat rollback.
  safePath(location.target, "file");
  requireBytes(location.target, source.after);
  try {
    fs.writeFileSync(location.target, source.before);
    requireBytes(location.target, source.before);
  } catch (error) {
    fs.writeFileSync(location.target, actual);
    requireBytes(location.target, actual);
    throw error;
  }
  return { status: "rolled-back", backupId: options.backupId };
}
