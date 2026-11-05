// The candidate report of the confirm path (issue #519): the evidence record and its deterministic
// rendering. Pure; confluence-evidence.mts holds the gates, confluence-evidence-cli.mts the I/O.
import type { Claim, Decision, Measurement } from './confluence-evidence.mts';

export interface EvidenceRecord {
  pageId: string; readVersion?: number; spaceId?: string; spaceKey?: string; parentId?: string | null; title?: string; body?: string;
  labels?: string[]; claim?: Claim; measurement?: Measurement; decision?: Decision; labelsAfter?: string[]; excluded?: string; reason?: string;
}
export const PROPOSED: readonly string[] = ['confirmed', 'refuted', 'superseded'];
// Reasons decided before the measurement was validated: its fields stay unprinted.
const UNVALIDATED = ['page-not-eligible', 'page-already-decided', 'labels-malformed', 'status-author-not-model', 'record-not-body-approved',
  'historical-not-repeatable', 'no-measurement', 'measurement-unknown-field', 'measurement-source-forbidden', 'measurement-incomplete',
  'excerpt-too-long', 'excerpt-control-chars', 'excerpt-secret-marker','measurement-stale', 'measurement-in-future'];
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1);
  return `${fence}text\n${text}\n${fence}`;
}
// Deterministic. No titles and no bodies; excerpts only for proposed changes and holds, which decide allows only
// for records prepared with --body-approved.
export function renderReport(records: readonly EvidenceRecord[]): string {
  const lines = ['# Brain drainage confirm path: candidate report', ''];
  const counts: Record<string, number> = { confirmed: 0, refuted: 0, superseded: 0, holds: 0, 'reported-only': 0, excluded: 0, failed: 0 };
  const unknown: Record<string, number> = {};
  for (const r of [...records].sort((a, b) => a.pageId.localeCompare(b.pageId, 'en', { numeric: true }))) {
    lines.push(`## Page ${r.pageId}`);
    const d = r.decision;
    if (r.excluded) { counts.excluded++; lines.push(`- excluded: ${r.excluded}`, `- reason: ${r.reason ?? 'none'}`, ''); continue; }
    const override = r.claim?.classifiedKind ? ` (override; classified ${r.claim.classifiedKind})` : '';
    lines.push(`- read version: ${r.readVersion ?? 'UNKNOWN'}`, `- kind: ${r.claim?.kind ?? 'UNKNOWN'}${override}`);
    if (!d) { counts.failed++; lines.push('- outcome: not decided', ''); continue; }
    if (d.outcome === 'unknown') unknown[d.reason] = (unknown[d.reason] ?? 0) + 1; else counts[d.outcome]++;
    const proposed = PROPOSED.includes(d.outcome);
    lines.push(`- outcome: ${d.outcome}`, `- reason: ${d.reason}`,
      `- label diff: ${proposed ? `${d.labelsAdd.map(l => `+${l}`).join(', ')} / ${d.labelsRemove.map(l => `-${l}`).join(', ')}` : 'none'}`,
      `- passive labels: ${r.claim?.passiveLabels.join(', ') || 'none'}`);
    const m = r.measurement;
    if (m && !UNVALIDATED.includes(d.reason)) {
      lines.push(`- measurement: ${m.measuredAt}, ${m.sourceClass} ${m.source}`);
      // Validated means secret-scanned, and present whenever the claim records an override.
      if (override) lines.push(`- kind override reason: ${m.kindOverride}`);
    }
    // holds (#695): the verbatim re-measurement of a body-approved record, for the operator's work record.
    if (m && (proposed || d.outcome === 'holds')) lines.push(`- verdict: ${m.verdict}`, '- command:', fenced(m.command), '- excerpt:', fenced(m.excerpt));
    lines.push('');
  }
  const total = Object.values(unknown).reduce((a, b) => a + b, 0);
  const reasons = Object.keys(unknown).sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }).map(k => `${k}: ${unknown[k]}`).join(', ');
  lines.push('## Totals', `- confirmed: ${counts.confirmed}`, `- refuted: ${counts.refuted}`, `- superseded: ${counts.superseded}`, `- holds: ${counts.holds}`,
    `- unknown: ${total}${total ? ` (${reasons})` : ''}`, `- reported-only: ${counts['reported-only']}`,
    `- excluded: ${counts.excluded}`, `- failed: ${counts.failed}`, '',
    'Coverage is limited to the pages listed above; every other page remains UNKNOWN.',
    'This is a model-run candidate report, not a Brain-confirmed verdict. Each proposed change needs explicit operator approval per page.');
  return `${lines.join('\n')}\n`;
}
