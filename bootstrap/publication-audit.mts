#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { requireTrustedExecutable } from '../claude/hooks/lib/trusted-executable.mts';

export interface AuditIssue { file: string; category: string }
export interface AuditReport { files: number; scanned: number; indexed: number; issues: AuditIssue[]; reviewed: AuditIssue[]; complete: boolean }
interface IndexEntry { mode: string; stage: number; bytes: Buffer }
interface WorkingEntry { bytes?: Buffer; direct: boolean; fault?: string }
const REVIEW_FILE = "bootstrap/publication-reviews.json";
type Review = readonly [string, string, string];

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

function indexBlobs(root: string): Map<string, IndexEntry[]> {
  const entries = execFileSync(requireTrustedExecutable('git'), ['-C', root, 'ls-files', '--stage', '-z'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean).map((entry) => {
      const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error('Invalid index inventory');
      return { mode: match[1], oid: match[2], stage: Number(match[3]), file: match[4] };
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
  const result = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const values = result.get(entry.file) || [];
    values.push({ mode: entry.mode, stage: entry.stage, bytes: bytesById.get(entry.oid) || Buffer.alloc(0) });
    result.set(entry.file, values);
  }
  return result;
}

const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9.-]/;
const LETTER = /[A-Za-z]/;

// Every address-shaped text: local part, @, and a domain that ends in a dot and two or more letters.
function emailAddresses(text: string): string[] {
  const found: string[] = [];
  let floor = 0; // the end of the previous address: a local part never reaches back over it
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    let start = at;
    while (start > floor && EMAIL_LOCAL.test(text[start - 1])) start -= 1;
    let stop = at + 1;
    while (stop < text.length && EMAIL_DOMAIN.test(text[stop])) stop += 1;
    if (start === at) continue;
    // The last dot of the domain run with a label before it and two letters after it.
    let dot = stop - 3;
    while (dot > at + 1 && !(text[dot] === '.' && LETTER.test(text[dot + 1]) && LETTER.test(text[dot + 2]))) dot -= 1;
    if (dot <= at + 1) continue;
    let end = dot + 3;
    while (end < stop && LETTER.test(text[end])) end += 1;
    found.push(text.slice(start, end));
    floor = end;
  }
  return found;
}

function inspectBytes(bytes: Buffer, needles: string[], add: (category: string) => void): void {
  const text = bytes.toString('utf8');
  if (needles.some((term) => text.toLowerCase().includes(term))) add('forbidden-content');
  const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|ENC\[AES256_GCM,|(?:AKIA|ASIA)[A-Z0-9]{16}/.test(text);
  // Hard predicates cover the complete decoded buffer, including bytes after NUL.
  if (bytes.includes(0)) { if (secret) add('secret-marker'); add('binary-review'); return; }
  const emails = emailAddresses(text);
  if (emails.some((email) => !/@(?:[^@]*\.)?(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i.test(email))) add('email-review');
  if (/https?:\/\/(?:[^\s/"']+\.(?:local|internal)(?:[:/\s"']|$)|(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d)/i.test(text)) add('private-endpoint');
  if (secret) add('secret-marker');
}

function workingEntry(root: string, file: string): WorkingEntry {
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(root + path.sep)) return { direct: false, fault: 'escaping-path' };
  try {
    if (!fs.lstatSync(absolute).isFile()) return { direct: false, fault: 'non-regular-file' };
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(root + path.sep)) return { direct: false, fault: 'escaping-path' };
    return { bytes: fs.readFileSync(real), direct: real === absolute };
  } catch { return { direct: false, fault: 'unreadable' }; }
}

// Evidence is fixed beside this trusted scanner, never supplied by CLI or a
// path in the evidence. A target without evidence is simply scanned in full.
function reviewEvidence(indexed: Map<string, IndexEntry[]>, working: Map<string, WorkingEntry>): Review[] | null {
  const entries = indexed.get(REVIEW_FILE) ?? [], target = working.get(REVIEW_FILE);
  if (!entries.length && !target) return [];
  try {
    const trustedPath = path.join(import.meta.dirname, 'publication-reviews.json');
    if (!fs.lstatSync(trustedPath).isFile() || fs.realpathSync(trustedPath) !== path.resolve(trustedPath)) return null;
    const trusted = fs.readFileSync(trustedPath);
    if (entries.length !== 1 || entries[0].stage !== 0 || !['100644', '100755'].includes(entries[0].mode)
      || !target?.bytes || !target.direct || !entries[0].bytes.equals(trusted) || !target.bytes.equals(trusted)) return null;
    const records: unknown = JSON.parse(trusted.toString('utf8'));
    if (!Array.isArray(records)) return null;
    const keys = new Set<string>(), hashes = new Map<string, string>();
    for (const value of records) {
      if (!Array.isArray(value) || value.length !== 3 || value.some(x => typeof x !== 'string')) return null;
      const [file, category, hash] = value as string[];
      if (!file.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')
        || file === REVIEW_FILE || !['email-review', 'private-endpoint', 'binary-review'].includes(category)
        || !/^[0-9a-f]{64}$/.test(hash) || keys.has(`${file}/${category}`)
        || hashes.has(file) && hashes.get(file) !== hash) return null;
      keys.add(`${file}/${category}`); hashes.set(file, hash);
    }
    return records as Review[];
  } catch { return null; }
}

export function auditRepository(repo: string, terms: string[]): AuditReport {
  const root = fs.realpathSync(repo);
  const files = [...new Set(execFileSync(requireTrustedExecutable('git'), [
    '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean))].sort((left, right) => Number(left > right) - Number(left < right));
  // This fixed public evidence file must not disappear behind an ignore rule.
  if (!files.includes(REVIEW_FILE)) {
    try { fs.lstatSync(path.join(root, REVIEW_FILE)); files.push(REVIEW_FILE); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') files.push(REVIEW_FILE); }
    files.sort((left, right) => Number(left > right) - Number(left < right));
  }
  const indexed = indexBlobs(root);
  const working = new Map(files.map(file => [file, workingEntry(root, file)]));
  const evidence = reviewEvidence(indexed, working);
  const report: AuditReport = { files: files.length, scanned: 0, indexed: 0, issues: [], reviewed: [], complete: evidence !== null };
  const needles = terms.map((term) => term.trim().toLowerCase()).filter(Boolean);
  if (evidence === null) report.issues.push({ file: safeLabel(REVIEW_FILE, needles), category: 'invalid-review' });
  const consumed = new Set<Review>();
  for (const file of files) {
    const categories = new Set<string>(), entries = indexed.get(file) ?? [], current = working.get(file)!;
    const add = (category: string) => { categories.add(category); };
    if (needles.some((term) => file.toLowerCase().includes(term))) add('forbidden-path');
    if (isSensitivePath(file)) add('sensitive-path');
    const indexCategories: Set<string>[] = [];
    for (const entry of entries) {
      report.indexed++;
      if (entry.stage !== 0) { add('index-conflict'); report.complete = false; }
      const found = new Set<string>(); indexCategories.push(found);
      if (!['100644', '100755'].includes(entry.mode)) { add('non-regular-index-entry'); report.complete = false; }
      else inspectBytes(entry.bytes, needles, category => { found.add(category); });
    }
    const currentCategories = new Set<string>();
    if (current.bytes) {
      report.scanned++;
      inspectBytes(current.bytes, needles, category => { currentCategories.add(category); });
    } else { add(current.fault!); report.complete = false; }
    const reviewedCategories = new Set<string>();
    for (const record of evidence ?? []) {
      if (record[0] !== file) continue;
      consumed.add(record);
      const [, category, hash] = record;
      if (entries.length === 1 && entries[0].stage === 0 && ['100644', '100755'].includes(entries[0].mode)
        && current.bytes && current.direct && createHash('sha256').update(entries[0].bytes).digest('hex') === hash
        && createHash('sha256').update(current.bytes).digest('hex') === hash
        && indexCategories[0].has(category) && currentCategories.has(category)) {
        reviewedCategories.add(category); report.reviewed.push({ file: safeLabel(file, needles), category });
      } else add('stale-review');
    }
    // Every source was classified and bound before path-level deduplication.
    for (const found of [...indexCategories, currentCategories]) for (const category of found) {
      if (!reviewedCategories.has(category)) add(category);
    }
    for (const category of categories) report.issues.push({ file: safeLabel(file, needles), category });
  }
  const orphanPaths = new Set<string>();
  for (const record of evidence ?? []) if (!consumed.has(record) && !orphanPaths.has(record[0])) {
    orphanPaths.add(record[0]); report.issues.push({ file: safeLabel(record[0], needles), category: 'stale-review' });
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
    process.exitCode = !report.complete ? 2 : report.issues.length ? 1 : 0;
  } catch {
    // Errors may include private filenames, policy terms or Git remote details.
    console.error('Publication audit could not complete; no clean result is available.');
    process.exitCode = 2;
  }
}
