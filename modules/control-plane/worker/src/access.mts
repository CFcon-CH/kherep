import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

import type { Env } from "./env.mts";
import { fail } from "./http.mts";

// Validates the Cloudflare Access JWT on every /api/* request, even though
// Access sits in front, so a misconfigured route cannot expose the API
// (issue #5, design section 5). Follows the documented jose recipe: JWKS at
// <team domain>/cdn-cgi/access/certs, issuer = team domain, audience = AUD.
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

// jose caches keys inside a remote JWKS set; keep one set per team domain for
// the isolate's lifetime instead of refetching the certs on every request.
const keySets = new Map<string, JWTVerifyGetKey>();

export type AccessResult = { ok: true; actor: string } | { ok: false; response: Response };

export function accessConfig(env: Env): { teamDomain: string; audience: string } | null {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/(?<!\/)\/+$/, "");
  const audience = (env.ACCESS_AUD ?? "").trim();
  if (!teamDomain || !audience || !/^https:\/\/[^/\s]+$/.test(teamDomain)) return null;
  return { teamDomain, audience };
}

export async function verifyAccess(request: Request, env: Env): Promise<AccessResult> {
  const config = accessConfig(env);
  // Fail closed: without a team domain and AUD there is nothing to verify against.
  if (!config) return { ok: false, response: fail(503, "access validation is not configured") };
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, response: fail(403, "missing access token") };

  let keySet = keySets.get(config.teamDomain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${config.teamDomain}/cdn-cgi/access/certs`));
    keySets.set(config.teamDomain, keySet);
  }
  try {
    const { payload } = await jwtVerify(token, keySet, { issuer: config.teamDomain, audience: config.audience });
    return { ok: true, actor: actorOf(payload) };
  } catch {
    return { ok: false, response: fail(403, "invalid access token") };
  }
}

// The first identity claim present: email, then common_name, then sub.
function actorOf(payload: JWTPayload): string {
  if (typeof payload.email === "string") return payload.email;
  if (typeof payload.common_name === "string") return payload.common_name;
  return payload.sub ?? "unknown";
}
