import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";

// Track only live read-only descriptors of declared synthetic record files.
// Descriptor close ends ownership. Post-read injection waits for the outer
// location check to take its final identity snapshot, then consumes the event
// before reentrant fixture writes.
export function watchInboxReads(t: TestContext, selected: string | ((file: string) => boolean),
  options: { after?: (file: string) => void; fault?: (file: string) => boolean } = {}) {
  const matches = typeof selected === "string"
    ? (file: string) => file.startsWith(selected + path.sep) && file.endsWith(".json") : selected;
  const live = new Map<number, string>(), failed = new Set<number>(), counts = new Map<string, number>();
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync, readFile = fs.readFileSync, lstat = fs.lstatSync;
  const pending = new Set<string>();
  const opened = t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = open(file, flags, mode);
    if (typeof file === "string" && matches(file) && (flags === "r" || typeof flags === "number" && (flags & 3) === fs.constants.O_RDONLY)) live.set(fd, file);
    return fd;
  });
  const reading = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const file = live.get(args[0]);
    if (file && options.fault?.(file)) { failed.add(args[0]); throw Object.assign(new Error("synthetic record read fault"), { code: "EIO" }); }
    try { return Reflect.apply(read, fs, args); } catch (error) { failed.add(args[0]); throw error; }
  });
  const completed = (file: string) => { counts.set(file, (counts.get(file) ?? 0) + 1); options.after?.(file); };
  const closing = t.mock.method(fs, "closeSync", (fd: number) => {
    const file = live.get(fd); live.delete(fd); close(fd);
    if (file && !failed.has(fd)) { counts.set(file, (counts.get(file) ?? 0) + 1); pending.add(file); }
    failed.delete(fd);
  });
  const checked = t.mock.method(fs, "lstatSync", ((...args: Parameters<typeof fs.lstatSync>) => {
    const value = Reflect.apply(lstat, fs, args);
    if (typeof args[0] === "string" && pending.delete(args[0])) options.after?.(args[0]);
    return value;
  }) as typeof fs.lstatSync);
  const direct = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const value = Reflect.apply(readFile, fs, args);
    if (typeof args[0] === "string" && matches(args[0])) completed(args[0]);
    return value;
  });
  return { counts, reads: () => [...counts.values()].reduce((a, b) => a + b, 0),
    restore: () => { opened.mock.restore(); reading.mock.restore(); closing.mock.restore(); direct.mock.restore(); checked.mock.restore(); live.clear(); pending.clear(); } };
}
