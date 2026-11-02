export type Runtime = 'claude' | 'codex';
export type Operation = 'issue.create' | 'issue.comment' | 'issue.update';
export type Request = { operationId: string; repository: string; operation: Operation | 'verify'; issueNumber?: number; title?: string; body?: string; state?: 'open' | 'closed'; stateReason?: 'completed' | 'not_planned' | 'reopened' };
export type ErrorCode = 'invalid-request' | 'policy-disabled' | 'policy-invalid' | 'key-access-denied' | 'auth-refused' | 'target-refused' | 'transport-failed' | 'verification-failed' | 'operation-conflict' | 'operation-busy' | 'receipt-invalid' | 'receipt-full' | 'outcome-unknown';
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
export function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function slug(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(value); }
export function parseRequest(text: string): Request {
  if (Buffer.byteLength(text) > 65536) fail('invalid-request');
  let x: Record<string, unknown>;
  try { x = object(JSON.parse(text)); } catch { return fail('invalid-request'); }
  if (typeof x.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x.operationId) || !slug(x.repository)) fail('invalid-request');
  const base = ['operationId', 'repository', 'operation'];
  const fields: Record<string, string[]> = { 'issue.create':['title','body'], 'issue.comment':['issueNumber','body'], 'issue.update':['issueNumber','title','body','state','stateReason'], verify:[] };
  if (typeof x.operation !== 'string' || !Object.hasOwn(fields, x.operation)) fail('invalid-request');
  exact(x, [...base, ...fields[x.operation]]);
  if (x.operation === 'issue.create' && x.title === undefined || x.operation === 'issue.comment' && x.body === undefined) fail('invalid-request');
  if (['issue.comment','issue.update'].includes(x.operation) && !positive(x.issueNumber)) fail('invalid-request');
  if (x.title !== undefined && (typeof x.title !== 'string' || !x.title.trim() || [...x.title].length > 256)) fail('invalid-request');
  if (x.body !== undefined && (typeof x.body !== 'string' || Buffer.byteLength(x.body) > 32768)) fail('invalid-request');
  if (x.state !== undefined && !['open','closed'].includes(String(x.state)) || x.stateReason !== undefined && !['completed','not_planned','reopened'].includes(String(x.stateReason))) fail('invalid-request');
  if (x.operation === 'issue.update' && !['title','body','state','stateReason'].some(k => x[k] !== undefined)) fail('invalid-request');
  x.operationId = x.operationId.toLowerCase();
  return x as Request;
}
export function payload(r: Request): Record<string, unknown> {
  return Object.fromEntries(['title','body','state','stateReason'].filter(k => r[k as keyof Request] !== undefined).map(k => [k === 'stateReason' ? 'state_reason' : k, r[k as keyof Request]]));
}
