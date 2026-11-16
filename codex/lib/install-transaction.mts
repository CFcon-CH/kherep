import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface Entry {
  directory: boolean;
  existed: boolean;
  relative: string;
  target: string;
}

const fileHash = (target: string): string | null => {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return null;
  return stat.isFile() ? createHash("sha256").update(fs.readFileSync(target)).digest("hex") : "not-a-file";
};

function exists(target: string): boolean {
  return Boolean(fs.lstatSync(target, { throwIfNoEntry: false }));
}

function retireStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

export class InstallTransaction {
  root: string;
  backupRoot: string;
  entries: Map<string, Entry>;
  createdGraveyards: string[];
  onWrite: ((target: string) => void) | null;
  // Issue #737. For the targets `ownershipChecked` names (the model-selection
  // outputs), the bytes (SHA-256, or null for absent) this transaction left
  // there. Rollback restores such a target only while it still holds them, so a
  // concurrent writer's later change is never overwritten. Every other target,
  // config.toml among them, is restored unconditionally.
  owned: Map<string, string | null>;
  ownershipChecked: (target: string) => boolean;

  constructor(root: string, backupRoot: string, onWrite: ((target: string) => void) | null = null,
    ownershipChecked: (target: string) => boolean = () => false) {
    this.root = path.resolve(root);
    this.backupRoot = path.resolve(backupRoot);
    this.entries = new Map();
    this.createdGraveyards = [];
    this.onWrite = onWrite;
    this.owned = new Map();
    this.ownershipChecked = ownershipChecked;
    fs.mkdirSync(this.backupRoot, { recursive: true });
  }

  relative(target: string): { relative: string; resolved: string } {
    const resolved = path.resolve(target);
    const relative = path.relative(this.root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Install target escapes Codex home: ${resolved}`);
    }
    return { relative, resolved };
  }

  stage(target: string): string {
    const { relative, resolved } = this.relative(target);
    if (this.entries.has(resolved)) return resolved;
    // An ancestor snapshot already contains the original child bytes. Restaging
    // a replaced child would overwrite that backup with post-change content.
    for (const entry of this.entries.values()) {
      const child = path.relative(entry.target, resolved);
      if (entry.directory && child && child !== ".." && !child.startsWith(`..${path.sep}`) && !path.isAbsolute(child)) return resolved;
    }
    const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
    const entry: Entry = { directory: Boolean(stat?.isDirectory()), existed: Boolean(stat), relative, target: resolved };
    this.entries.set(resolved, entry);
    if (stat) {
      const backup = path.join(this.backupRoot, relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.cpSync(resolved, backup, { recursive: stat.isDirectory() });
    }
    return resolved;
  }

  remove(target: string): string {
    const resolved = this.stage(target);
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { force: true, recursive: true });
    this.own(resolved, null);
    return resolved;
  }

  own(resolved: string, hash: string | null): void {
    if (this.entries.get(resolved)?.directory === false && this.ownershipChecked(resolved)) this.owned.set(resolved, hash);
  }

  // #44. Retirement parks instead of deleting, as bootstrap/transaction-retire.sh
  // does: the file moves into a _deprecated/ sibling after its backup is staged,
  // so rollback puts it back at the original path. An occupied destination gets
  // the dated suffix .<YYYYmmdd-HHMMSS>, counted up -1, -2, ... until free; a
  // parked file is never overwritten. The stamp parameter exists for tests only.
  park(target: string, stamp: string = retireStamp()): string {
    const resolved = this.stage(target);
    const graveyard = path.join(path.dirname(resolved), "_deprecated");
    if (!exists(graveyard)) {
      fs.mkdirSync(graveyard);
      this.createdGraveyards.push(graveyard);
    }
    let dest = path.join(graveyard, path.basename(resolved));
    if (exists(dest)) {
      const dated = `${dest}.${stamp}`;
      dest = dated;
      for (let attempt = 1; exists(dest); attempt += 1) dest = `${dated}-${attempt}`;
    }
    fs.renameSync(resolved, dest);
    this.own(resolved, null);
    this.onWrite?.(dest);
    return dest;
  }

  installDir(source: string, target: string): string {
    const sourceStat = fs.statSync(source, { throwIfNoEntry: false });
    if (!sourceStat?.isDirectory()) throw new Error(`Install source directory missing: ${source}`);
    const resolved = this.remove(target);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.cpSync(source, resolved, { recursive: true });
    this.owned.delete(resolved);
    this.onWrite?.(resolved);
    return resolved;
  }

  copyFile(source: string, target: string): string {
    const sourceStat = fs.statSync(source, { throwIfNoEntry: false });
    if (!sourceStat?.isFile()) throw new Error(`Install source file missing: ${source}`);
    const resolved = this.remove(target);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.copyFileSync(source, resolved);
    this.own(resolved, fileHash(resolved));
    this.onWrite?.(resolved);
    return resolved;
  }

  writeFile(target: string, content: string): string {
    const resolved = this.stage(target);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    this.own(resolved, createHash("sha256").update(content, "utf8").digest("hex"));
    this.onWrite?.(resolved);
    return resolved;
  }

  // Restores in reverse order; targets named in `last` (the model-selection
  // anchor) are restored after everything else. Returns the relative paths left
  // in place because a concurrent writer changed them after this transaction.
  rollback(options: { last?: readonly string[] } = {}): string[] {
    const last = new Set((options.last ?? []).map((target) => path.resolve(target)));
    const ordered = [...this.entries.values()].reverse();
    const conflicts: string[] = [];
    for (const entry of [...ordered.filter((row) => !last.has(row.target)), ...ordered.filter((row) => last.has(row.target))]) {
      if (this.owned.has(entry.target) && fileHash(entry.target) !== this.owned.get(entry.target)) {
        conflicts.push(entry.relative);
        continue;
      }
      if (fs.existsSync(entry.target)) fs.rmSync(entry.target, { force: true, recursive: true });
      if (entry.existed) {
        const backup = path.join(this.backupRoot, entry.relative);
        fs.mkdirSync(path.dirname(entry.target), { recursive: true });
        const stat = fs.statSync(backup);
        fs.cpSync(backup, entry.target, { recursive: stat.isDirectory() });
      }
    }
    // A parked copy stays where it is: removing it would be the delete park()
    // avoids. A _deprecated/ this run created goes only while it is empty.
    for (const graveyard of this.createdGraveyards.reverse()) {
      try { fs.rmdirSync(graveyard); } catch { /* holds a parked copy */ }
    }
    this.createdGraveyards = [];
    return conflicts;
  }

  targets(): string[] {
    return [...this.entries.keys()];
  }
}
