import { outgoingIds } from './confluence-related.mts';
import { claimBody, claimViews, plainText as plain, revisionBody, revisionLines } from './confluence-evidence.mts';

export interface Snapshot {
  id: string; version: number; title: string; spaceId: string; parentId: string | null;
  body: string; labels: string[];
}
export interface Candidate {
  pageId: string; readVersion: number; problem: string;
  proposedAction: 'review-format' | 'review-link' | 'review-duplicate' | 'verify-current-status' | 'recheck-evidence';
  evidence: string; uncertainty: 'UNKNOWN'; relatedPageId?: string;
  // #693 revision-stale only: ids, commits and the changed bound paths of the operator's checkout.
  detail?: { repository: string; boundCommit: string; comparedRef: string; comparedSha: string; changedPaths: string[] };
}
function meaningful(body: string): Set<string> {
  // Related navigation and provenance metadata must not manufacture duplicates.
  const content = body.split(/<h[1-6][^>]*>\s*(?:Related(?: pages)?|See also)\s*<\/h[1-6]>/i)[0];
  const text = plain(content).replace(/^(?:Revision|Origin|Timestamp|Source|Session):.*$/gmi, '');
  const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  return new Set(words);
}
function candidate(p: Snapshot, problem: string, proposedAction: Candidate['proposedAction'], evidence: string): Candidate {
  return {pageId:p.id,readVersion:p.version,problem,proposedAction,evidence,uncertainty:'UNKNOWN'};
}
// The published observation body grammar lives in confluence-evidence.mts, so the
// confirm path and this scanner cannot disagree about a page it promoted.
function revisionsValid(body: string, labels: string[]): boolean {
  const { bound, unbound, malformed } = revisionLines(body);
  const nonConfirmed = !labels.includes('evidence-confirmed')
    && labels.some(label=>['evidence-assumed','evidence-refuted','evidence-superseded'].includes(label));
  return bound.length + unbound.length > 0 && !malformed.length && (nonConfirmed || !unbound.length);
}
export function drainageRules(pages: Snapshot[], graphComplete: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const p of pages) {
    const text = plain(p.body);
    // Only the author's claim decides code-boundness; the run of measurement blocks decide appended before the footer is metadata (#650, #666).
    const claim = plain(claimBody(p.body));
    const codeBound = /^[^\S\n\r\u2028\u2029]*(?:Code|Repository|Repo|Revision|Commit|Code[- ]bound)\s*:/im.test(claimViews(claimBody(p.body)).join('\n'))
      || /\b[\w/-]+\.(?:mts|ts|tsx|js|py|java|go|rs)\b/.test(claim);
    // Revision lines are read without base-form blocks, positional or not, tail optional, as on d5c15f4 (#650 T8, #666).
    if (p.labels.includes('type-observation') && codeBound && !revisionsValid(revisionBody(p.body),p.labels)) {
      out.push(candidate(p,'revision-missing-or-invalid','review-format','Code-bound observation lacks valid repository@full-SHA Revision lines (with an optional repo-relative path list) or an allowed non-confirmed no-binding declaration; original evidence required.'));
    }
    if (/only because (?:the )?search returned (?:it|this|that|them)/i.test(text)) {
      out.push(candidate(p,'search-only-link-justification','review-link','Explicit search-only justification; inspect link context before changing it.'));
    }
    const tracker = /\b[A-Z][A-Z0-9]+-\d+\b/.test(text)
      || /\bGitHub\s+(?:issue|PR|pull request)\s*#\d+\b/i.test(text) || /\/issues\/\d+\b/.test(p.body);
    if (tracker && /\b(?:is|are|remains?|currently)\s+(?:still\s+)?(?:done|closed|resolved|open|in progress)\b/i.test(text)) {
      out.push(candidate(p,'tracker-status-needs-verification','verify-current-status','Tracker status wording detected; live status and historical date are UNKNOWN.'));
    }
  }
  const terms = pages.map(p => meaningful(p.body));
  for (let i=0;i<pages.length;i++) {
    if (terms[i].size < 12) continue;
    for (let j=i+1;j<pages.length;j++) {
      if (terms[j].size < 12) continue;
      const common = [...terms[i]].filter(t => terms[j].has(t)).length;
      const ratio = common/(terms[i].size+terms[j].size-common);
      if (ratio >= 0.88) out.push({...candidate(pages[i],'possible-near-duplicate','review-duplicate',
        `Meaningful content token overlap ${Math.round(ratio*100)}%; historical release scope requires review.`),relatedPageId:pages[j].id});
    }
  }
  if (graphComplete) {
    const incoming = new Set<string>();
    for (const p of pages) for (const id of outgoingIds(p.body)) if (id !== p.id) incoming.add(id);
    for (const p of pages) if (!incoming.has(p.id)) out.push(candidate(p,'no-incoming-link','review-link',
      'No incoming explicit page-id link observed in the fully read visible space graph; hierarchy and external links are outside this measure.'));
  }
  return out;
}
