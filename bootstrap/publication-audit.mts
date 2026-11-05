#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { requireTrustedExecutable } from '../claude/hooks/lib/trusted-executable.mts';

export interface AuditIssue { file: string; category: string }
export interface AuditReport { files: number; scanned: number; indexed: number; issues: AuditIssue[] }

// Keep organization-specific terms in a local policy file, never in the public tree.
function isSensitivePath(file: string): boolean {
  return /(?:^|\/)(?:secrets|credentials|host_vars|group_vars)(?:\/|$)/i.test(file)
    || /\.(?:p12|pfx|key|pem|crt)$/i.test(file);
}

function safeLabel(file: string, terms: string[]): string {
  if (terms.some((term) => file.toLowerCase().includes(term.toLowerCase()))
    || isSensitivePath(file)) {
    return `redacted-path:${createHash('sha256').update(file).digest('hex').slice(0, 16)}`;
  }
  return file;
}

function indexBlobs(root: string): Map<string, { mode: string; bytes: Buffer }[]> {
  const entries = execFileSync(requireTrustedExecutable('git'), ['-C', root, 'ls-files', '--stage', '-z'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean).map((entry) => {
      const match = /^(\d+) ([a-f0-9]+) [0-3]\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error('Invalid index inventory');
      return { mode: match[1], oid: match[2], file: match[3] };
    });
  const ids = [...new Set(entries.filter((entry) => entry.mode !== '160000').map((entry) => entry.oid))];
  const bytesById = new Map<string, Buffer>();
  if (ids.length) {
    const output = execFileSync(requireTrustedExecutable('git'), ['-C', root, 'cat-file', '--batch'], {
      input: ids.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024,
    });
    let offset = 0;
    for (const oid of ids) {
      const end = output.indexOf(10, offset);
      const header = /^([a-f0-9]+) blob (\d+)$/.exec(output.subarray(offset, end).toString('ascii'));
      if (end < offset || !header || header[1] !== oid) throw new Error('Unreadable index object');
      const size = Number(header[2]);
      offset = end + 1;
      if (!Number.isSafeInteger(size) || output[offset + size] !== 10) throw new Error('Incomplete index object');
      bytesById.set(oid, output.subarray(offset, offset + size));
      offset += size + 1;
    }
    if (offset !== output.length) throw new Error('Unexpected index output');
  }
  const result = new Map<string, { mode: string; bytes: Buffer }[]>();
  for (const entry of entries) {
    const values = result.get(entry.file) || [];
    values.push({ mode: entry.mode, bytes: bytesById.get(entry.oid) || Buffer.alloc(0) });
    result.set(entry.file, values);
  }
  return result;
}

function inspectBytes(bytes: Buffer, needles: string[], add: (category: string) => void): void {
  if (bytes.includes(0)) { add('binary-review'); return; }
  const text = bytes.toString('utf8');
  if (needles.some((term) => text.toLowerCase().includes(term))) add('forbidden-content');
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  if (emails.some((email) => !/@(?:[^@]*\.)?(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i.test(email))) add('email-review');
  if (/https?:\/\/(?:[^\s/"']+\.(?:local|internal)(?:[:/\s"']|$)|(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d)/i.test(text)) add('private-endpoint');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|ENC\[AES256_GCM,|(?:AKIA|ASIA)[A-Z0-9]{16}/.test(text)) add('secret-marker');
}

export function auditRepository(repo: string, terms: string[]): AuditReport {
  const root = fs.realpathSync(repo);
  const files = [...new Set(execFileSync(requireTrustedExecutable('git'), [
    '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean))].sort((left, right) => Number(left > right) - Number(left < right));
  const indexed = indexBlobs(root);
  const report: AuditReport = { files: files.length, scanned: 0, indexed: 0, issues: [] };
  const needles = terms.map((term) => term.trim().toLowerCase()).filter(Boolean);
  for (const file of files) {
    const categories = new Set<string>();
    const add = (category: string) => {
      if (categories.has(category)) return;
      categories.add(category);
      report.issues.push({ file: safeLabel(file, needles), category });
    };
    if (needles.some((term) => file.toLowerCase().includes(term))) add('forbidden-path');
    if (isSensitivePath(file)) add('sensitive-path');
    for (const entry of indexed.get(file) || []) {
      report.indexed++;
      if (!['100644', '100755'].includes(entry.mode)) add('non-regular-index-entry');
      else inspectBytes(entry.bytes, needles, add);
    }
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(root + path.sep)) { add('escaping-path'); continue; }
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile()) { add('non-regular-file'); continue; }
      // Recheck parents too: a repository directory can itself be a symlink.
      const real = fs.realpathSync(absolute);
      if (!real.startsWith(root + path.sep)) { add('escaping-path'); continue; }
      const bytes = fs.readFileSync(real);
      report.scanned++;
      inspectBytes(bytes, needles, add);
    } catch { add('unreadable'); }
  }
  return report;
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const args = process.argv.slice(2);
    const repo = args[0] || process.cwd();
    const policy = args[1];
    if (!policy) throw new Error('External publication policy required');
    const terms: unknown = JSON.parse(fs.readFileSync(policy, 'utf8'));
    if (!Array.isArray(terms) || !terms.length || terms.some((term) => typeof term !== 'string' || !term.trim())) {
      throw new Error('Invalid publication policy');
    }
    const report = auditRepository(repo, terms);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.issues.length ? 1 : 0;
  } catch {
    // Errors may include private filenames, policy terms or Git remote details.
    console.error('Publication audit could not complete; no clean result is available.');
    process.exitCode = 2;
  }
}
