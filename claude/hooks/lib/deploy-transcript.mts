import fs from 'node:fs';
import path from 'node:path';

// The executed installation, never an event field or environment override,
// supplies the projects root. This does not authenticate a native session.
export function transcriptLines(transcriptPath: unknown, hooksDirectory: string): string[] {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || transcriptPath.includes('\0')) return [];
  try {
    const hooks = fs.realpathSync.native(hooksDirectory);
    if (path.basename(hooks) !== 'hooks') return [];
    const projects = path.join(path.dirname(hooks), 'projects');
    if (fs.realpathSync.native(projects) !== projects || !fs.statSync(projects).isDirectory()) return [];
    const file = fs.realpathSync.native(transcriptPath);
    const relative = path.relative(projects, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
    const before = fs.lstatSync(transcriptPath);
    if (!before.isFile()) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return [];
      return fs.readFileSync(fd, 'utf8').split(/\r?\n/).filter(Boolean);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

export function humanText(text: string): string {
  // Public deliver-core markers also survive the task-admission/session-runner
  // wrappers. A peer row ends the search; it must not revive older approval.
  return /=== Kherep peer message |--- (?:end of )?message text \[|^(?:Task |Follow-up for task ).*via the Kherep Control Plane/m.test(text) ? '' : text;
}
