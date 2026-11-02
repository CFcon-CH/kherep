import { fail, object } from './contract.mts';
export type Http = (method:'GET'|'POST'|'PATCH', endpoint:string, token:string, body?:Record<string, unknown>) => Promise<Record<string, unknown>>;
export function transport(fetcher: typeof fetch = fetch): Http {
  let count = 0;
  return async (method, endpoint, token, body) => {
    if (++count > 10 || !/^\/(?:[A-Za-z0-9_./-]|%5B|%5D)+$/.test(endpoint) || endpoint.includes('..')) fail('transport-failed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(`https://api.github.com${endpoint}`, {method, redirect:'error', signal:controller.signal, headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2026-03-10','User-Agent':'kherep-github-broker','Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
      if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > 1048576 || !response.body) fail('transport-failed');
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 1048576) { controller.abort(); fail('transport-failed'); } chunks.push(chunk); }
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { return fail('transport-failed'); } finally { clearTimeout(timer); }
  };
}
