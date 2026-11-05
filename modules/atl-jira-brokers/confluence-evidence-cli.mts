// The evidence verb (issue #519): the modes around the pure gates in
// confluence-evidence.mts. Confluence is read with GET only; local files and git
// go through confluence-evidence-io.mts. Stdout carries ids, versions, kinds,
// labels, reasons and counts only.
import type { ConfluenceSession } from './confluence-contract.mts';
import { findSpace, getPage, getPageBody } from './confluence-content.mts';
import { drainageRules } from './confluence-drainage-rules.mts';
import { drainageSnapshot } from './confluence-drainage-snapshot.mts';
import {
  BOUND_REVISION, claimSpan, classifyClaim, decide, evidenceLabelsOk, insertBeforeFooter, KINDS, normaliseMeasurement, renderMeasurementBlock, revisionBody, revisionLines,
  type Claim, type DecideOptions, type Decision, type Measurement, type MeasuredKind,
} from './confluence-evidence.mts';
import {
  execFileAsync, fail, nodeFiles, readJson, readRecord, requireAbsent, requireOutside, TIMEOUT, type FileOps, type Io,
} from './confluence-evidence-io.mts';
import { PROPOSED, renderReport, type EvidenceRecord } from './confluence-evidence-report.mts';
import type { NeighbourArgs, NeighbourCliContext } from './confluence-neighbour-cli.mts';
import { readFailure } from './confluence-pagination.mts';
import { gitProbe, repositoryOf } from './confluence-revision-staleness-git.mts';
import { runtimeLabel } from './confluence-runtime-label.mts';
import type { ExecLike } from './confluence-semantic.mts';
import { createSession } from './confluence-session.mts';

export interface EvidenceDeps {
  exec?: ExecLike;
  files?: FileOps;
  // Injected by tests only; the broker builds the session from its context.
  session?: ConfluenceSession;
}

const approved = (io: Io): boolean => Object.hasOwn(io.args, 'body-approved');
function numeric(value: string | undefined, flag: string): string {
  return value !== undefined && /^\d+$/.test(value) ? value : fail(`${flag} must be a numeric page id.`);
}

async function prepare(io: Io): Promise<number> {
  const { args, ctx } = io;
  if (!approved(io)) fail('Classify the page and approve its body for this session before preparing (--body-approved).');
  const id = numeric(args.id, '--id');
  if (args.kind !== undefined && !KINDS.includes(args.kind)) fail('--kind takes code, tracker, live or doc.');
  const out = await requireOutside(io, 'out');
  await requireAbsent(io, out, 'out');
  const session = io.session();
  const space = await findSpace(session, args.space ?? '') ?? fail('No space with that key is visible to the service account.');
  const snapshot = await drainageSnapshot(session, id, space.id)
    .catch((error: unknown) => fail(`Snapshot failed: ${readFailure(error).reason}. Nothing was written.`));
  const claim = classifyClaim(snapshot, true, args.kind as MeasuredKind | undefined);
  const [from, to] = claimSpan(snapshot.body);
  const blocks = (snapshot.body.slice(from, to).match(/<h2>Measurement /g) ?? []).length;
  const record: EvidenceRecord = { pageId: id, readVersion: snapshot.version, spaceId: space.id, spaceKey: space.key,
    parentId: snapshot.parentId, title: snapshot.title, body: snapshot.body, labels: snapshot.labels, claim };
  await io.files.create(out, JSON.stringify(record, null, 2));
  const { bound, unbound, malformed } = claim.revisions;
  for (const line of [`id: ${id}`, `version: ${snapshot.version}`,
    `kind: ${claim.kind}${claim.classifiedKind ? ` (override; classified ${claim.classifiedKind})` : ''}`,
    `evidence: ${claim.evidenceLabel}`, `status-author: ${claim.statusAuthor}`, `passive labels: ${claim.passiveLabels.join(', ') || 'none'}`,
    `revisions: bound ${bound.length}, unbound ${unbound.length}, malformed ${malformed.length}`,
    `code tokens: ${claim.codeTokens.length}`, `tracker keys: ${claim.trackerKeys.length}`,
    `measurement blocks: ${blocks}`, 'record: written']) ctx.log(line);
  return 0;
}

// git sees only a validated 40-hex SHA and the operator's checkout path.
async function repository(io: Io, m: Partial<Measurement> | null, claim: Claim): Promise<Partial<DecideOptions>> {
  const root = io.args['repo-root'];
  if (!root) return {};
  const sha = (m?.revision ?? '').slice(-40);
  if (m?.kind !== 'code' || !BOUND_REVISION.test(m.revision ?? '') || !/^[0-9a-f]{40}$/.test(sha)) return { repoRoot: root };
  const top = await io.exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], TIMEOUT).then(r => r.stdout.trim(), () => '');
  const exists = await io.exec('git', ['-C', root, 'cat-file', '-t', sha], TIMEOUT).then(r => r.stdout.trim() === 'commit', () => false);
  // #695: on a confirmed page an unbound revision may be a strict descendant of a bound commit of the same
  // repository (merge-base prints the bound sha). A failed probe answers "not newer"; nothing is fetched.
  let newer = false;
  const revision = m.revision ?? '';
  if (exists && claim.evidenceLabel === 'confirmed' && !claim.revisions.bound.includes(revision)) {
    const probe = gitProbe(io.exec, root), name = repositoryOf(revision.slice(0, -41));
    for (const bound of claim.revisions.bound) {
      const base = bound.slice(-40);
      if (repositoryOf(bound.slice(0, -41)) !== name || base === sha) continue;
      if (await probe.ancestor(base, sha) === 'yes') { newer = true; break; }
    }
  }
  return { repoRoot: root, ...(top ? { repoTopLevel: top } : {}), revisionExists: (candidate: string) => candidate === sha && exists,
    revisionNewer: (candidate: string) => candidate === revision && newer };
}

async function decideMode(io: Io): Promise<number> {
  const { args, ctx } = io;
  const raw = args['max-age-days'];
  const maxAgeDays = raw === undefined ? undefined : Number(raw);
  if (maxAgeDays !== undefined && (!Number.isInteger(maxAgeDays) || maxAgeDays < 0)) fail('--max-age-days must be a whole number.');
  if (maxAgeDays !== undefined && maxAgeDays > 7) fail('max-age-days-above-cap: --max-age-days is capped at 7.');
  const supersededBy = args['superseded-by'];
  if (supersededBy !== undefined) numeric(supersededBy, '--superseded-by');
  // The superseding page's title enters this process, so its read needs approval too.
  if (supersededBy !== undefined && !approved(io)) fail('--superseded-by reads another page; approve it first (--body-approved).');
  const outBody = await requireOutside(io, 'out-body');
  const recordPath = await requireOutside(io, 'record');
  const record = await readRecord(io, recordPath);
  if (!record.claim || typeof record.body !== 'string') fail('--record holds no prepared page.');
  if (supersededBy === record.pageId) fail('superseded-same-page: --superseded-by names the page itself.');
  // LF-only from here on: the record, the gates and the rendered body see the same strings.
  const measurement = normaliseMeasurement(await readJson(io, 'measurement'));
  const m = measurement && typeof measurement === 'object' ? measurement as Partial<Measurement> : null;
  if (supersededBy !== undefined && m?.supersededBy !== undefined && m.supersededBy !== supersededBy) {
    fail('--superseded-by differs from supersededBy in the measurement.');
  }
  const options: DecideOptions = { now: ctx.now(), maxAgeDays, ...(await repository(io, m, record.claim!)) };
  if (supersededBy !== undefined) {
    const page = await getPage(io.session(), supersededBy);
    if (page.status !== 'current') fail('superseded-page-not-current: the superseding page is not current.');
    // #687: the target's own bound Revision lines, from its author body; same space only, never printed or written.
    const bound = page.spaceId === record.spaceId ? revisionLines(revisionBody(await getPageBody(io.session(), supersededBy, 'storage'))).bound : [];
    options.superseded = { id: page.id, title: page.title, spaceId: page.spaceId, spaceKey: record.spaceKey ?? '', bound };
  }
  let decision: Decision = decide(record.claim!, measurement, options);
  const labels = record.labels ?? [];
  let body: string | undefined;
  let after = labels;
  if (PROPOSED.includes(decision.outcome)) {
    const runtime = runtimeLabel(ctx.credEnv, ctx.env);
    // The labels call adds the broker's runtime label to a page that carries none; verify expects it too.
    const added = [...decision.labelsAdd, ...(labels.some(l => l.startsWith('runtime-')) ? [] : [runtime])];
    after = [...new Set([...labels.filter(l => !decision.labelsRemove.includes(l)), ...added])].sort((left, right) => Number(left > right) - Number(left < right));
    body = insertBeforeFooter(record.body!, renderMeasurementBlock(decision, m as Measurement, runtime, options.superseded));
    // Defect 1, checked on the result: the next drainage scan must accept the promoted page.
    const scan = drainageRules([{ id: record.pageId, version: record.readVersion ?? 0, title: '', spaceId: record.spaceId ?? '',
      parentId: null, body, labels: after }], false);
    if (scan.some(c => c.problem === 'revision-missing-or-invalid')) {
      decision = { outcome: 'unknown', reason: 'promoted-body-revision-invalid', labelsAdd: [], labelsRemove: [] };
      [body, after] = [undefined, labels];
    }
  }
  const keep = decision.reason !== 'excerpt-secret-marker' && m ? { measurement: m as Measurement } : {};
  const updated: EvidenceRecord = { ...record, ...keep, decision, labelsAfter: after };
  if (body !== undefined) await io.files.write(outBody, body);
  await io.files.write(recordPath, JSON.stringify(updated, null, 2));
  const diff = decision.labelsAdd.length ? `${decision.labelsAdd.map(l => `+${l}`).join(', ')} / ${decision.labelsRemove.map(l => `-${l}`).join(', ')}` : 'none';
  for (const line of [`outcome: ${decision.outcome}`, `reason: ${decision.reason}`, `labels: ${diff}`,
    `body: ${body === undefined ? 'not written' : 'written'}`]) ctx.log(line);
  // holds (#695) is a measured result with nothing to write, so it exits 0 like a proposed change.
  return body === undefined && decision.outcome !== 'holds' ? 2 : 0;
}

async function verify(io: Io): Promise<number> {
  const record = await readRecord(io);
  const outcome = record.decision?.outcome ?? '';
  const reviewed = record.labelsAfter ?? [];
  if (!PROPOSED.includes(outcome) || !Array.isArray(record.labelsAfter)) fail('--record holds no proposed change to verify.');
  const file = io.args['body-file'] ?? fail('--body-file is missing.');
  const expected = await io.ctx.readFile(file, 'utf8').catch(() => fail('--body-file is not readable.'));
  const snapshot = await drainageSnapshot(io.session(), record.pageId, record.spaceId ?? '')
    .catch((error: unknown) => fail(`Readback failed: ${readFailure(error).reason}. Result UNVERIFIED.`));
  const evidence = snapshot.labels.filter(l => l.startsWith('evidence-')).sort((left, right) => Number(left > right) - Number(left < right));
  // The full set, not only the evidence label: a status-author or any other change since prepare is a mismatch.
  const diff = [...snapshot.labels.filter(l => !reviewed.includes(l)).sort((left, right) => Number(left > right) - Number(left < right)).map(l => `+${l}`),
    ...reviewed.filter(l => !snapshot.labels.includes(l)).sort((left, right) => Number(left > right) - Number(left < right)).map(l => `-${l}`)];
  io.ctx.log(`version: ${snapshot.version}`);
  if (snapshot.body !== expected) io.ctx.log('readback: mismatch body');
  else if (diff.length || !evidenceLabelsOk(snapshot.labels, outcome)) {
    io.ctx.log(`readback: mismatch labels (${diff.join(', ') || evidence.join(', ') || 'none'})`);
  }
  else { io.ctx.log('readback: match'); return 0; }
  return 2;
}

async function report(io: Io): Promise<number> {
  const files = (io.args.records ?? '').split(',').filter(Boolean);
  if (!files.length) fail('--records is missing.');
  const records: EvidenceRecord[] = [];
  for (const file of files) records.push(await readRecord(io, file));
  io.ctx.log(renderReport(records).trimEnd());
  return 0;
}

async function recordMode(io: Io): Promise<number> {
  const id = numeric(io.args.id, '--id');
  const excluded = io.args.excluded ?? '';
  if (!['private', 'unavailable'].includes(excluded)) fail('--excluded takes private or unavailable.');
  // A slug, not prose: free text could carry page content into the report.
  const reason = io.args.reason ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(reason)) fail('--reason must be a short slug such as private-no-local-route.');
  const out = await requireOutside(io, 'out');
  await requireAbsent(io, out, 'out');
  await io.files.create(out, JSON.stringify({ pageId: id, excluded, reason }, null, 2));
  for (const line of [`id: ${id}`, `excluded: ${excluded}`, `reason: ${reason}`]) io.ctx.log(line);
  return 0;
}

const MODES: Record<string, (io: Io) => Promise<number>> = { prepare, decide: decideMode, verify, report, record: recordMode };

// Exit 0: proposed change, holds or report; 2: unknown, reported-only or readback
// mismatch; a thrown ConfluenceError is exit 1 at the broker boundary.
export async function cmdEvidence(ctx: NeighbourCliContext, args: NeighbourArgs, deps: EvidenceDeps = {}): Promise<number> {
  const run = MODES[args.mode ?? ''];
  if (!Object.hasOwn(MODES, args.mode ?? '')) fail('--mode takes prepare, decide, verify, report or record.');
  let session = deps.session;
  return run({ ctx, args, exec: deps.exec ?? execFileAsync, files: deps.files ?? nodeFiles,
    session: () => (session ??= createSession(ctx)) });
}
