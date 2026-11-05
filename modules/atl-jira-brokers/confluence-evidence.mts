// The pure half of the confirm path (issue #519): Revision grammar, claim classification, promotion gates,
// measurement block and report. No I/O; confluence-evidence-cli.mts reads, runs git and writes local files.
import { createHash } from 'node:crypto';
import { RELATED_HEADING } from './confluence-neighbours.mts';

// #693: the Revision grammar and claim text live in confluence-claim-text.mts; re-exported for every current importer.
import { BOUND_REVISION, claimViews, DIRTY_LINE, plainText, revisionLines, type Revisions } from './confluence-claim-text.mts';
export { BOUND_REVISION, claimViews, DIRTY_LINE, NO_BINDING_LINE, plainText, revisionLines, scopedRevision, type Revisions, type Scoped } from './confluence-claim-text.mts';
// Copied, not imported (neither source is in the broker install closure): codex-output.mts:76-81 in
// modules/control-plane/node and bootstrap/publication-audit.mts:67. A hit is refused, never redacted.
export const SECRET_MARKERS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_*-]{8,}/, /Bearer\s+\S+/i, /eyJ[\w-]+\.[\w-]+\.[\w-]+/, /\/\/[^\s/@]+@/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s?#]*\?[^\s#]*(?:token|key|secret|password|sig)=/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /ENC\[AES256_GCM,/, /(?:AKIA|ASIA)[A-Z0-9]{16}/,
];

export type MeasuredKind = 'code' | 'tracker' | 'live' | 'doc';
export type Kind = MeasuredKind | 'historical' | 'unclassified';
// holds (#695): a confirmed page measured again and still true; nothing to write.
export type Outcome = 'confirmed' | 'refuted' | 'superseded' | 'holds' | 'unknown' | 'reported-only';
export interface ClaimSource { id: string; version: number; spaceId: string; body: string; labels: string[] }
export interface Claim {
  pageId: string; spaceId: string; readVersion: number; bodySha256: string; bodyApproved: boolean; labels: string[];
  typeLabel: string | null; evidenceLabel: string; statusAuthor: string; kind: Kind; classifiedKind?: Kind;
  signals: Kind[]; revisions: Revisions; codeTokens: string[]; trackerKeys: string[]; passiveLabels: string[];
}
export interface Measurement {
  kind: MeasuredKind; source: string; sourceClass: string; command: string; excerpt: string; measuredAt: string;
  verdict: 'reproduces' | 'contradicts'; revision?: string; subject?: string; supersededBy?: string; kindOverride?: string;
}
export interface SupersedingPage { id: string; title: string; spaceId: string; spaceKey: string; bound?: string[] }
export interface DecideOptions { now: number; maxAgeDays?: number; repoRoot?: string; repoTopLevel?: string;
  revisionExists?: (sha: string) => boolean; revisionNewer?: (revision: string) => boolean; superseded?: SupersedingPage }
export interface Decision { outcome: Outcome; reason: string; labelsAdd: string[]; labelsRemove: string[]; measuredRevision?: string; supersededBy?: string }

export const KINDS: readonly string[] = ['code', 'tracker', 'live', 'doc'];
const CLASS_OF: Record<string, string> = { code: 'repository', tracker: 'tracker', live: 'target-host', doc: 'official-doc' };
const FIELDS = new Set(['kind', 'source', 'sourceClass', 'command', 'excerpt', 'measuredAt', 'verdict', 'revision', 'subject', 'supersededBy', 'kindOverride']);
const DAY = 86_400_000;
const unique = (values: Iterable<string>): string[] => [...new Set(values)].sort((left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
});
const suffixes = (labels: string[], prefix: string): string[] => labels.filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length));
const filled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const targetOf = (m: Measurement, o: DecideOptions): string | undefined => m.supersededBy ?? o.superseded?.id, noBinding = (r: Revisions): boolean => !r.bound.length && r.unbound.length > 0;

export function classifyClaim(snapshot: ClaimSource, bodyApproved: boolean, kindOverride?: MeasuredKind): Claim {
  const labels = [...snapshot.labels].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  const original = claimBody(snapshot.body);
  const text = plainText(original), lines = claimViews(original).join('\n'); // tokens and phrases: base text; line-anchored claims: both views
  const revisions = revisionLines(revisionBody(snapshot.body));
  const codeTokens = unique(text.match(/\b[\w./-]+\.(?:mts|ts|tsx|js|py|java|go|rs)\b/g) ?? []);
  const githubKeys = [...text.matchAll(/\bGitHub\s+(?:issue|PR|pull request)\s*#(\d+)\b/gi),
    ...original.matchAll(/\/(?:issues|pull)\/(\d+)\b/g)].map(m => `#${m[1]}`);
  // Once the page names one GitHub key, every #N it states is one ("#10 and #648"); a numeric entity is not.
  if (githubKeys.length > 0) githubKeys.push(...[...text.replace(/&#\w+;/g, ' ').matchAll(/(?<!\w)#(\d+)\b/g)].map(m => `#${m[1]}`));
  const trackerKeys = unique([...(text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []), ...githubKeys]);
  // Priority order: a bound revision makes code repeatable; nothing repeats a historical claim.
  const has: [Kind, boolean][] = [
    ['code', [revisions.bound, revisions.unbound, revisions.malformed].some(lines => lines.length > 0) || codeTokens.length > 0
      || /(?:^|\n)\s*(?:Code|Repository|Repo|Commit|Code[- ]bound)\s*:/im.test(lines)],
    ['historical', /\b(?:historical(?:ly)?|at the time of (?:measurement|writing))\b/i.test(text)],
    ['tracker', trackerKeys.length > 0],
    ['live', /(?:^|\n)\s*(?:Host|Target|Deployment|Live)\s*:/im.test(lines) || /\b(?:kubectl|systemctl|journalctl)\b/.test(text)],
    ['doc', /(?:^|\n)\s*(?:Doc|Documentation)\s*:/im.test(lines) || /https?:\/\/(?:developer\.atlassian\.com|docs\.)/.test(original)],
  ];
  const signals = has.filter(([, on]) => on).map(([kind]) => kind);
  const classified: Kind = signals[0] ?? 'unclassified';
  const evidence = suffixes(labels, 'evidence-');
  const authors = suffixes(labels, 'status-author-');
  return {
    pageId: snapshot.id, spaceId: snapshot.spaceId, readVersion: snapshot.version,
    bodySha256: createHash('sha256').update(snapshot.body).digest('hex'), bodyApproved, labels,
    typeLabel: labels.find(l => l === 'type-observation') ?? labels.find(l => l === 'type-knowledge') ?? null,
    evidenceLabel: evidence.length === 1 && ['confirmed', 'assumed', 'refuted', 'superseded'].includes(evidence[0]) ? evidence[0] : 'malformed',
    statusAuthor: authors.length === 0 ? 'missing'
      : authors.length === 1 && ['model', 'verified', 'operator'].includes(authors[0]) ? authors[0] : 'malformed',
    kind: kindOverride ?? classified, ...(kindOverride && kindOverride !== classified ? { classifiedKind: classified } : {}),
    signals, revisions, codeTokens, trackerKeys,
    passiveLabels: labels.filter(l => l.startsWith('currency-') || l === 'origin-wiki'),
  };
}
function calendarDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const at = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  return m && at && at.getUTCFullYear() === +m[1] && at.getUTCMonth() === +m[2] - 1 && at.getUTCDate() === +m[3] ? at.getTime() / DAY : null;
}
// The host's calendar day: a measurement is dated the day its command ran there.
function today(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
}
// Confluence may rewrite a lone CR on PUT while update --expected-version compares the readback
// byte-exactly, so every measurement string is LF-only before the gates and before rendering.
export function normaliseMeasurement<T>(m: T): T {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return m;
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : v])) as T;
}
function measurementGate(claim: Claim, m: Record<string, unknown>, options: DecideOptions): string | null {
  if (Object.keys(m).some(key => !FIELDS.has(key))) return 'measurement-unknown-field';
  const sourceClass = String(m.sourceClass);
  if (!Object.values(CLASS_OF).includes(sourceClass) || (KINDS.includes(String(m.kind)) && CLASS_OF[String(m.kind)] !== sourceClass)) {
    return 'measurement-source-forbidden';
  }
  const measured = typeof m.measuredAt === 'string' ? calendarDay(m.measuredAt) : null;
  if (!KINDS.includes(String(m.kind)) || !['reproduces', 'contradicts'].includes(String(m.verdict)) || measured === null
    || !['source', 'command', 'excerpt'].every(key => filled(m[key]))
    || ['revision', 'subject', 'supersededBy', 'kindOverride'].some(key => m[key] !== undefined && typeof m[key] !== 'string')
    || (m.supersededBy !== undefined && !/^\d+$/.test(String(m.supersededBy)))
    || (claim.classifiedKind !== undefined && !filled(m.kindOverride))) return 'measurement-incomplete';
  if (String(m.excerpt).length > 4000) return 'excerpt-too-long';
  // Every field is rendered into the page or the report, so every field is checked.
  const strings = Object.values(m).filter((v): v is string => typeof v === 'string');
  // C0 controls other than tab, LF and CR (an ANSI escape, say) could rewrite a terminal or the report.
  if (strings.some(v => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))) return 'excerpt-control-chars';
  if (strings.some(v => SECRET_MARKERS.some(marker => marker.test(v)))) return 'excerpt-secret-marker';
  const age = today(options.now) - measured;
  if (age > (options.maxAgeDays ?? 2)) return 'measurement-stale';
  return age < 0 ? 'measurement-in-future' : null;
}
function codeGate(claim: Claim, m: Measurement, options: DecideOptions): string | null {
  const revision = m.revision;
  if (!revision) return 'revision-missing';
  if (DIRTY_LINE.test(revision)) return 'revision-dirty';
  if (!BOUND_REVISION.test(revision)) return 'revision-malformed';
  if (!options.repoRoot || !options.repoTopLevel || !options.revisionExists) return 'revision-not-verified';
  const at = revision.lastIndexOf('@');
  const name = revision.slice(0, at).split('/').at(-1);
  if (name !== options.repoTopLevel.split(/[\\/]/).filter(Boolean).at(-1)) return 'repo-root-name-mismatch';
  if (!options.revisionExists(revision.slice(at + 1))) return 'revision-not-in-repository';
  if (!claim.revisions.bound.includes(revision)) {
    const target = targetOf(m, options) !== undefined;
    // #695: a confirmed page may be measured at a strict descendant of its binding; a later change never refutes it.
    if (claim.evidenceLabel === 'confirmed') {
      if (!options.revisionNewer?.(revision)) return target ? 'revision-not-newer' : 'revision-not-on-page';
      if (m.verdict === 'contradicts' && !target) return 'revision-not-on-page';
    } else if (!(m.verdict === 'contradicts' && target && noBinding(claim.revisions))) return 'revision-not-on-page'; // #687: supersedeGate checks the target
  }
  // Drainage rejects unbound Revision lines once a page is confirmed (Defect 1).
  if (m.verdict === 'reproduces' && claim.revisions.unbound.length + claim.revisions.malformed.length > 0) return 'revision-unbound-on-page';
  return null;
}
const word = (key: string): RegExp => new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
// gh issue view --json state,closedAt prints no number, so the command may name the issue it reads, but
// only as ONE invocation: its first segment is exactly gh issue|pr view N (quotes stripped, nothing before,
// no suffix), and no other gh runs anywhere in it. A bare number elsewhere (a date, a count) never stands for #N.
const SHELL_WORD = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;
const GH_WORD = /(?<![\w./-])gh(?![\w.-])/;
function ghViewNumber(command: string): string | null {
  const [first, ...rest] = command.split(/&&|\|\||;|\||\n/);
  // An unbalanced quote leaves characters no word consumed; such a segment names nothing.
  if (first.replace(SHELL_WORD, '').trim() !== '') return null;
  const words = (first.match(SHELL_WORD) ?? []).map(w => w.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
  const [gh, noun, verb, n = ''] = words;
  if (gh !== 'gh' || (noun !== 'issue' && noun !== 'pr') || verb !== 'view' || !/^[1-9]\d*$/.test(n)) return null;
  return [words.slice(1).join(' '), ...rest].some(part => GH_WORD.test(part)) ? null : n;
}
// #N is a whole token: #10. and #10, end a sentence, #10-other and #10.5 are other names.
const github = (n: string, m: Measurement): boolean =>
  new RegExp(`(?<!\\w)#${n}(?!\\w|[-.][A-Za-z0-9])`).test(m.excerpt) || ghViewNumber(m.command) === n;
function touches(claim: Claim, m: Measurement): boolean {
  const hay = `${m.command}\n${m.excerpt}`;
  // Every tracker key the page states (a read of one key must not confirm a page about several), on word
  // boundaries (KEY-1 is not KEY-12); a non-GitHub key must appear in the excerpt. Code needs any one token.
  if (m.kind === 'tracker') return claim.trackerKeys.length > 0 && claim.trackerKeys.every(key => key.startsWith('#')
    ? github(key.slice(1), m) : word(key).test(m.excerpt));
  if (m.kind === 'code') return [...claim.codeTokens, ...(m.subject ? [m.subject] : [])].some(token => hay.includes(token));
  return filled(m.subject) && hay.includes(m.subject ?? '');
}
function supersedeGate(claim: Claim, m: Measurement, options: DecideOptions): string | null {
  const target = targetOf(m, options), confirmed = claim.evidenceLabel === 'confirmed';
  if (confirmed && target !== undefined && m.verdict === 'reproduces') return 'superseded-needs-contradiction';
  if (m.verdict !== 'contradicts' || target === undefined) return null;
  if (target === claim.pageId) return 'superseded-same-page';
  if (!options.superseded || options.superseded.id !== target) return 'superseded-needs-page';
  if (options.superseded.spaceId !== claim.spaceId) return 'superseded-other-space';
  // A confirmed page's target must bind the measured revision itself (#695); an assumed page's page or target may (#687).
  const binds = (bound?: string[]): boolean => bound?.includes(m.revision ?? '') ?? false;
  return m.kind === 'code' && !binds(options.superseded.bound) && (confirmed || !binds(claim.revisions.bound)) ? 'superseded-page-not-bound' : null;
}
const refuse = (reason: string, outcome: Outcome = 'unknown'): Decision => ({ outcome, reason, labelsAdd: [], labelsRemove: [] });
// Gates run in order; the first failing gate names the reason. No measurement never promotes, so neither does a format repair.
export function decide(claim: Claim, measurement: unknown, options: DecideOptions): Decision {
  if (!claim.typeLabel) return refuse('page-not-eligible');
  if (claim.evidenceLabel === 'refuted' || claim.evidenceLabel === 'superseded') return refuse('page-already-decided');
  if (claim.evidenceLabel === 'malformed' || claim.statusAuthor === 'malformed') return refuse('labels-malformed');
  if (claim.statusAuthor !== 'model') return refuse('status-author-not-model', claim.statusAuthor === 'missing' ? 'unknown' : 'reported-only');
  if (!claim.bodyApproved) return refuse('record-not-body-approved');
  // A --kind override never makes a historical claim repeatable.
  if (claim.kind === 'historical' || claim.classifiedKind === 'historical') return refuse('historical-not-repeatable');
  if (measurement === undefined) return refuse('no-measurement');
  if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement)) return refuse('measurement-incomplete');
  const m = normaliseMeasurement(measurement) as Measurement;
  const reason = measurementGate(claim, m as unknown as Record<string, unknown>, options)
    ?? (claim.kind === 'unclassified' ? 'unclassified-claim' : null)
    ?? (m.kind !== claim.kind ? 'kind-mismatch' : null)
    ?? (m.kind === 'code' ? codeGate(claim, m, options) : null)
    ?? (touches(claim, m) ? null : 'measurement-does-not-touch-claim')
    ?? supersedeGate(claim, m, options);
  if (reason) return refuse(reason);
  const revision = m.kind === 'code' ? { measuredRevision: m.revision } : {};
  if (m.verdict === 'reproduces' && claim.evidenceLabel === 'confirmed') return { outcome: 'holds', reason: 'measured', labelsAdd: [], labelsRemove: [], ...revision };
  const outcome: Outcome = m.verdict === 'reproduces' ? 'confirmed' : targetOf(m, options) ? 'superseded' : 'refuted';
  return { outcome, reason: 'measured', labelsAdd: [`evidence-${outcome}`], labelsRemove: [`evidence-${claim.evidenceLabel}`],
    ...revision, ...(outcome === 'superseded' ? { supersededBy: targetOf(m, options) } : {}) };
}
// Measured on the live site (issue #662, 2026-10-22): Confluence returns " in text nodes as &quot; and keeps
// ' raw, so a body written in that form survives the byte-exact update readback. &amp;, &lt; and &gt; are
// the XML forms; whether Confluence returns > as &gt; or raw was not measured separately.
export const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = escapeText;
// Renderer and recogniser are one contract (the gates test enforces agreement). Every text field is escaped, so no
// field contains '<'; the date must appear twice and agree. A superseded block always ends in its link; no other does.
const FIELD = '[^<]*';
const REST = ` \\(model-run, status-author-model unchanged\\)</p>\\s*(?:<p>Revision: ${FIELD}</p>\\s*)?`
  + `<p>Source: (?:code|tracker|live|doc), ${FIELD}</p>\\s*<p>Command: <code>${FIELD}</code></p>\\s*<pre>${FIELD}</pre>\\s*<p>Measured via ${FIELD} on \\1\\.</p>`;
const TAIL = `\\s*<p>Superseded by: <a href="/wiki/spaces/[^"<]*/pages/\\d+">${FIELD}</a></p>`;
export const MEASUREMENT_BLOCK = new RegExp(`<h2>Measurement (\\d{4}-\\d{2}-\\d{2})</h2>\\s*<p>Outcome: (?:(?:confirmed|refuted)${REST}|superseded${REST}${TAIL})`, 'gs');
const footerCut = (body: string): number => { const at = body.lastIndexOf(RELATED_HEADING); return at >= 0 ? at : body.length; };
// decide's run (blocks split only by whitespace, ending at the LAST footer cut) hides code tokens. Revisions are read as on d5c15f4: base-form blocks removed anywhere, tail optional (#666).
export function claimSpan(body: string): [number, number] { const cut = footerCut(body); let [start, end] = [cut, -1]; // one forward scan
  for (const m of body.slice(0, cut).matchAll(MEASUREMENT_BLOCK)) [start, end] = [end >= 0 && !body.slice(end, m.index).trim() ? start : m.index, m.index + m[0].length];
  return [end >= 0 && !body.slice(end, cut).trim() ? start : cut, cut]; }
export const claimBody = (body: string): string => { const [from, to] = claimSpan(body); return body.slice(0, from) + body.slice(to); };
const REVISION_CORE = new RegExp(`<h2>Measurement (\\d{4}-\\d{2}-\\d{2})</h2>\\s*<p>Outcome: (confirmed|refuted|superseded)${REST}(${TAIL})?`, 'gs');
export const revisionBody = (body: string): string => body.replace(REVISION_CORE, (_b, _d, outcome: string, tail?: string) => outcome === 'superseded' ? '' : tail ?? '');
export function renderMeasurementBlock(decision: Decision, raw: Measurement, runtimeLabel: string, superseded?: SupersedingPage): string {
  const m = normaliseMeasurement(raw);
  const parts = [`<h2>Measurement ${xml(m.measuredAt)}</h2>`,
    `<p>Outcome: ${xml(decision.outcome)} (model-run, status-author-model unchanged)</p>`];
  if (decision.measuredRevision) parts.push(`<p>Revision: ${xml(decision.measuredRevision)}</p>`);
  parts.push(`<p>Source: ${xml(m.kind)}, ${xml(m.source)}</p>`, `<p>Command: <code>${xml(m.command)}</code></p>`,
    `<pre>${xml(m.excerpt)}</pre>`, `<p>Measured via ${xml(runtimeLabel)} on ${xml(m.measuredAt)}.</p>`);
  if (superseded && decision.outcome === 'superseded') {
    const href = `/wiki/spaces/${encodeURIComponent(superseded.spaceKey)}/pages/${encodeURIComponent(superseded.id)}`;
    parts.push(`<p>Superseded by: <a href="${xml(href)}">${xml(superseded.title)}</a></p>`);
  }
  return parts.join('');
}
export function insertBeforeFooter(body: string, block: string): string {
  const cut = footerCut(body);
  const out = body.slice(0, cut) + block + body.slice(cut);
  if (out.slice(0, cut) !== body.slice(0, cut) || out.slice(cut + block.length) !== body.slice(cut)) throw new Error('Footer insertion changed existing bytes.');
  return out;
}
export function evidenceLabelsOk(labels: readonly string[], outcome: string): boolean {
  const evidence = labels.filter(label => label.startsWith('evidence-'));
  return evidence.length === 1 && evidence[0] === `evidence-${outcome}`;
}
