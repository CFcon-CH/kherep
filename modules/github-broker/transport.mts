import { fail, object } from './contract.mts';
/** The one answer of a GET that was asked to treat 404 as absent. Compare by identity. */
export const ABSENT: Record<string, unknown> = Object.freeze({});
/** `list` reads a top-level JSON array as `{items}` (GET only, and only there with a query); any other answer must be an object. */
export type Http = (method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE', endpoint:string, token:string, body?:Record<string, unknown>, absent?:boolean, list?:boolean) => Promise<Record<string, unknown>>;
// Created/accepted/no-content answers may carry no body (workflow run rerun and cancel).
const EMPTY_OK = [201, 202, 204];
const PATH = /^\/(?:[A-Za-z0-9_./-]|%5B|%5D)+$/, QUERY = /^\/(?:[A-Za-z0-9_./-]|%5B|%5D)+\?[A-Za-z0-9_.=&:/-]+$/;
// The only DELETE: one branch ref (branch.delete).
const BRANCH_REF = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/git\/refs\/heads\/[A-Za-z0-9._/-]+$/;
/** `limit` requests per invocation; an operation raises it only through its handler's `requests`. */
export function transport(fetcher: typeof fetch = fetch, limit = 10): Http {
  let count = 0;
  return async (method, endpoint, token, body, absent, list) => {
    const shaped = list ? method === 'GET' && (PATH.test(endpoint) || QUERY.test(endpoint)) : PATH.test(endpoint) && (method !== 'DELETE' || BRANCH_REF.test(endpoint));
    if (++count > limit || !shaped || endpoint.includes('..')) fail('transport-failed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(`https://api.github.com${endpoint}`, {method, redirect:'error', signal:controller.signal, headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2026-03-10','User-Agent':'kherep-github-broker','Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
      if (absent && method === 'GET' && response.status === 404 && !response.redirected) { await response.body?.cancel(); return ABSENT; }
      if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > 1048576) fail('transport-failed');
      if (!response.body) return !list && EMPTY_OK.includes(response.status) ? {} : fail('transport-failed');
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 1048576) { controller.abort(); fail('transport-failed'); } chunks.push(chunk); }
      if (bytes === 0 && !list && EMPTY_OK.includes(response.status)) return {};
      const answer: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (list) return Array.isArray(answer) ? {items:answer} : fail('transport-failed');
      return object(answer);
    } catch { return fail('transport-failed'); } finally { clearTimeout(timer); }
  };
}
