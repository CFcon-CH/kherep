export type Runtime = 'claude' | 'codex';
export const ISSUE_OPERATIONS = ['issue.create','issue.comment','issue.update'] as const;
export const GITHUB_OPERATIONS = ['branch.push','pr.create','pr.update','pr.comment','run.rerun','run.cancel'] as const;
export type IssueOperation = typeof ISSUE_OPERATIONS[number];
export type Operation = IssueOperation | typeof GITHUB_OPERATIONS[number];
export type Request = { operationId: string; repository: string; operation: Operation | 'verify' | 'identity'; issueNumber?: number; title?: string; body?: string; labels?: string[]; state?: 'open' | 'closed'; stateReason?: 'completed' | 'not_planned' | 'reopened';
  branch?: string; sha?: string; head?: string; base?: string; draft?: boolean; prNumber?: number; runId?: number; failedOnly?: boolean };
export type ErrorCode = 'invalid-request' | 'label-required' | 'policy-disabled' | 'policy-invalid' | 'key-access-denied' | 'auth-refused' | 'target-refused' | 'transport-failed' | 'verification-failed' | 'operation-conflict' | 'operation-busy' | 'receipt-invalid' | 'receipt-full' | 'outcome-unknown';
export class BrokerError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.code = code; }
}
export function fail(code: ErrorCode): never { throw new BrokerError(code); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-request');
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) fail('invalid-request');
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA = /^[0-9a-f]{40}$/;
export function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function slug(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(value); }
/** A plain branch name of this repository: no ref prefix, owner, glob, `..` or trailing dot. */
export function refName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && value !== 'HEAD' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !/\.\.|\/\/|\/\.|\.lock(?:\/|$)|[/.]$/.test(value);
}
function validLabels(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 20 && new Set(value).size === value.length
    && value.every(l => typeof l === 'string' && l.length > 0 && l.length <= 50 && l === l.trim() && !l.includes(','));
}
const FIELDS: Record<string, string[]> = {
  'issue.create':['title','body','labels'], 'issue.comment':['issueNumber','body'], 'issue.update':['issueNumber','title','body','state','stateReason'], verify:[], identity:[],
  'branch.push':['branch','sha'], 'pr.create':['head','base','title','body','draft','labels'], 'pr.update':['prNumber','title','body','state','base'], 'pr.comment':['prNumber','body'],
  'run.rerun':['runId','failedOnly'], 'run.cancel':['runId'],
};
const REQUIRED: Record<string, string[]> = {
  'issue.create':['title'], 'issue.comment':['issueNumber','body'], 'issue.update':['issueNumber'], 'branch.push':['branch','sha'], 'pr.create':['head','base','title'],
  'pr.update':['prNumber'], 'pr.comment':['prNumber','body'], 'run.rerun':['runId'], 'run.cancel':['runId'],
};
export function parseRequest(text: string): Request {
  if (Buffer.byteLength(text) > 65536) fail('invalid-request');
  let x: Record<string, unknown>;
  try { x = object(JSON.parse(text)); } catch { return fail('invalid-request'); }
  if (typeof x.operationId !== 'string' || !UUID.test(x.operationId) || !slug(x.repository)) fail('invalid-request');
  if (typeof x.operation !== 'string' || !Object.hasOwn(FIELDS, x.operation)) fail('invalid-request');
  exact(x, ['operationId', 'repository', 'operation', ...FIELDS[x.operation]]);
  if ((REQUIRED[x.operation] ?? []).some(k => x[k] === undefined)) fail('invalid-request');
  if (['issueNumber','prNumber','runId'].some(k => x[k] !== undefined && !positive(x[k]))) fail('invalid-request');
  if (['branch','head','base'].some(k => x[k] !== undefined && !refName(x[k])) || x.sha !== undefined && (typeof x.sha !== 'string' || !SHA.test(x.sha))) fail('invalid-request');
  if (['draft','failedOnly'].some(k => x[k] !== undefined && typeof x[k] !== 'boolean')) fail('invalid-request');
  if (x.title !== undefined && (typeof x.title !== 'string' || !x.title.trim() || [...x.title].length > 256)) fail('invalid-request');
  if (x.body !== undefined && (typeof x.body !== 'string' || Buffer.byteLength(x.body) > 32768)) fail('invalid-request');
  if (x.labels !== undefined && !validLabels(x.labels)) fail('invalid-request');
  if (x.state !== undefined && !['open','closed'].includes(String(x.state)) || x.stateReason !== undefined && !['completed','not_planned','reopened'].includes(String(x.stateReason))) fail('invalid-request');
  if (x.operation === 'issue.update' && !['title','body','state','stateReason'].some(k => x[k] !== undefined)) fail('invalid-request');
  if (x.operation === 'pr.update' && !['title','body','state','base'].some(k => x[k] !== undefined)) fail('invalid-request');
  x.operationId = x.operationId.toLowerCase();
  return x as Request;
}
/** The given receipt fields that are set, in the given order: the public IDs of an operation. */
export function pickIds<T extends object>(receipt: T, keys: (keyof T & string)[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(k => receipt[k]).map(k => [k, receipt[k]]));
}
/** The actor is exactly the runtime's bot account. */
export function isBotActor(identity: { botId: number; botLogin: string }, actor: unknown): boolean {
  const user = actor as Record<string, unknown> | null;
  return !!user && user.id === identity.botId && user.login === identity.botLogin && user.type === 'Bot';
}
export function payload(r: Request): Record<string, unknown> {
  return Object.fromEntries(['title','body','labels','state','stateReason'].filter(k => r[k as keyof Request] !== undefined).map(k => [k === 'stateReason' ? 'state_reason' : k, r[k as keyof Request]]));
}
