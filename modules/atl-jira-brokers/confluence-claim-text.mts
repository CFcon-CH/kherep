// The published observation Revision grammar (issues #519, #693). The confirm path, the drainage scanner and the
// revision staleness check all import it from here, so they judge a page alike. Pure: no I/O.
import { replaceTags } from './confluence-topic-query.mts';

// <name>@<40 hex>: the binding core. The drainage scanner and the evidence gates compare cores by equality.
export const BOUND_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*@[0-9a-f]{40}$/;
export const NO_BINDING_LINE = /^none \(no exact binding: (?:no repository|no full commit SHA|dirty tree|malformed repository or revision)\)$/;
export const DIRTY_LINE = /^(.*) \(no exact binding: dirty tree\)$/;
// #693: a repo-relative, forward-slash path. No leading '/' or '-', no '.'/'..' or empty segment, no trailing '/',
// and no space, glob, ':' (git pathspec magic), '\' or entity character; git receives it as :(literal)<path>.
export const PATH = /^(?!-)(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)*$/;
export const MAX_PATHS = 16, MAX_PATH_LENGTH = 200;
export interface Scoped { core: string; paths: string[] }
// bound holds cores; paths maps a core to the union of the path lists its bound lines name.
export interface Revisions { bound: string[]; unbound: string[]; malformed: string[]; paths: Record<string, string[]> }

// A path list is 1..16 distinct paths, each at most 200 characters and valid under PATH.
export function pathListOk(paths: readonly string[]): boolean {
  return paths.length >= 1 && paths.length <= MAX_PATHS && new Set(paths).size === paths.length
    && paths.every(p => p.length <= MAX_PATH_LENGTH && PATH.test(p));
}
// '<name>@<sha>' or '<name>@<sha> -- <path>( <path>)*' (spaces already collapsed); null for anything else.
export function scopedRevision(line: string): Scoped | null {
  const at = line.indexOf(' -- ');
  const core = at < 0 ? line : line.slice(0, at);
  if (!BOUND_REVISION.test(core)) return null;
  if (at < 0) return { core, paths: [] };
  const paths = line.slice(at + 4).split(' ');
  return pathListOk(paths) ? { core, paths } : null;
}

// #669: plainText(body) is the base text. With a mark, only a </pre> closing an outermost <pre> ends a line; outer comments, CDATA and PIs become marks.
export function plainText(body: string, mark = ''): string { let depth = 0;
  const marked = body.replace(/<!--[^]*?(?:-->|$)|<!\[CDATA\[[^]*?(?:\]\]>|$)|<\?[^]*?(?:\?>|$)|<\/pre>|<pre\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi, tag => /^<[!?]/.test(tag) ? (mark && !depth ? mark : tag)
    : tag[1] === '/' ? (depth > 0 && --depth === 0 && mark ? `${tag}\n${mark}` : tag) : tag.endsWith('/>') ? tag : (depth++ === 0 && mark ? `${mark}\n${tag}` : tag));
  return replaceTags(marked.replace(/<\/(?:p|div|h[1-6]|li)>/gi, '\n'), () => ' ').replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ').replace(/[ \t]+/g, ' ').trim();
}
const CLAIM_BARRIER = '\x01';
function markedClaimLine(line: string): string {
  let start = 0;
  while (start < line.length && /\s/.test(line[start])) start++;
  if (line[start] !== CLAIM_BARRIER) return CLAIM_BARRIER;
  while (start < line.length && (line[start] === CLAIM_BARRIER || /\s/.test(line[start]))) start++;
  return line.slice(start);
}
export const claimViews = (body: string): [string, string] => [plainText(body), [CLAIM_BARRIER,
  ...plainText(body, CLAIM_BARRIER).split('\n').map(markedClaimLine)].join('\n')];
export function revisionLines(body: string): Revisions { // claimViews: the base text, then the lines after a real </pre> or region; every other line is a \x01 barrier (#672 review)
  const out: Revisions = { bound: [], unbound: [], malformed: [], paths: {} };
  for (const [view, text] of claimViews(body).entries()) for (const match of text.matchAll(/^[^\S\n\r\u2028\u2029]*Revision\s*:\s*((?:\S[^\n]*)?)/gim)) {
    const trimmed = match[1].trim(), line = trimmed === CLAIM_BARRIER ? '' : trimmed, scoped = scopedRevision(line);
    const kind = scoped ? 'bound' : NO_BINDING_LINE.test(line) || scopedRevision(DIRTY_LINE.exec(line)?.[1] ?? '') ? 'unbound' : 'malformed';
    // A bound entry is its core, so equality consumers see '<name>@<sha>'; scoped lines of one core merge into one entry.
    const entry = scoped?.core ?? line;
    if ((view === 0 && !scoped?.paths.length) || !out[kind].includes(entry)) out[kind].push(entry);
    if (scoped?.paths.length) out.paths[scoped.core] = [...new Set([...(out.paths[scoped.core] ?? []), ...scoped.paths])];
  }
  return out;
}
