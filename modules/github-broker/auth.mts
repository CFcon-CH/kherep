import { createPrivateKey, sign } from 'node:crypto';
import { fail } from './contract.mts';
import type { Identity } from './config.mts';
import type { Http } from './transport.mts';
export type Permissions = Record<string, 'read'|'write'>;
export function jwt(key: Buffer, clientId: string, now: number): string {
  try {
    const privateKey = createPrivateKey(key);
    if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail('key-access-denied');
    const encode = (x:unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
    const claims = `${encode({alg:'RS256',typ:'JWT'})}.${encode({iat:Math.floor(now/1000)-60,exp:Math.floor(now/1000)+300,iss:clientId})}`;
    return `${claims}.${sign('RSA-SHA256',Buffer.from(claims),privateKey).toString('base64url')}`;
  } catch { return fail('key-access-denied'); }
}
// The App or installation grants every wanted permission at the wanted level or above.
function grants(have:unknown, want:Permissions):boolean {
  const granted = have as Record<string,unknown>|null;
  return !!granted && Object.entries(want).every(([k,v]) => granted[k] === 'write' || v === 'read' && granted[k] === 'read');
}
/**
 * App and installation identity, then one repository-scoped installation token
 * with exactly `permissions` (plus GitHub's implicit metadata:read). The token
 * stays in memory. Returns it with the checked public repository object.
 */
export async function authenticateRepository(http:Http, key:Buffer, identity:Identity, repo:{slug:string;id:number}, now:number, permissions:Permissions): Promise<{token:string; target:Record<string,unknown>}> {
  const signed = jwt(key, identity.clientId, now);
  const app = await http('GET','/app',signed);
  if (app.id !== identity.appId || app.client_id !== identity.clientId || !grants(app.permissions, permissions) || typeof app.slug !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(app.slug) || identity.botLogin !== `${app.slug}[bot]`) fail('auth-refused');
  const installation = await http('GET',`/repos/${repo.slug}/installation`,signed);
  if (installation.id !== identity.installationId || installation.app_id !== identity.appId || installation.suspended_at !== null || !grants(installation.permissions, permissions)) fail('auth-refused');
  const token = await http('POST',`/app/installations/${identity.installationId}/access_tokens`,signed,{repository_ids:[repo.id],permissions});
  if (typeof token.token !== 'string' || !/^[-A-Za-z0-9_.]+$/.test(token.token) || token.token.length > 4096 || typeof token.expires_at !== 'string' || !Number.isFinite(Date.parse(token.expires_at)) || Date.parse(token.expires_at) <= now + 15000) fail('auth-refused');
  if (token.permissions !== undefined) {
    const perms = token.permissions as Record<string,unknown>;
    if (!perms || Object.entries(permissions).some(([k,v]) => perms[k] !== v) || Object.entries(perms).some(([k,v]) => !(permissions[k] === v || k === 'metadata' && v === 'read'))) fail('auth-refused');
  }
  if (token.repository_selection !== undefined && token.repository_selection !== 'selected') fail('auth-refused');
  if (token.repositories !== undefined && (!Array.isArray(token.repositories) || token.repositories.length !== 1 || token.repositories[0]?.id !== repo.id || token.repositories[0]?.full_name !== repo.slug || token.repositories[0]?.private !== false)) fail('auth-refused');
  let bot:Record<string,unknown>;
  try {bot=await http('GET',`/users/${encodeURIComponent(identity.botLogin)}`,token.token);}catch{return fail('auth-refused');}
  if (bot.id!==identity.botId || bot.login!==identity.botLogin || bot.type!=='Bot') fail('auth-refused');
  const target = await http('GET',`/repos/${repo.slug}`,token.token);
  if (target.id !== repo.id || target.full_name !== repo.slug || target.private !== false || target.visibility !== undefined && target.visibility !== 'public') fail('target-refused');
  return {token:token.token, target};
}
export async function authenticate(http:Http, key:Buffer, identity:Identity, repo:{slug:string;id:number}, now:number, permissions:Permissions={issues:'write'}): Promise<string> {
  return (await authenticateRepository(http,key,identity,repo,now,permissions)).token;
}
