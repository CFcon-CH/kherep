import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey as JoseKey, type JWTPayload } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accessConfig, verifyAccess } from "../src/access.mts";
import type { Env } from "../src/env.mts";
import { BASE } from "./helpers.mts";

// Issue #965: which identity claim becomes the actor, and an absent Access
// configuration. A team domain of its own keeps this file's JWKS out of the
// key-set cache the other Access tests use.
const TEAM = "https://claims-team.example.com";
const AUD = "claims-audience";
const ENV = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as Env;
let signingKey: JoseKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "claims-kid", alg: "RS256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return new Response("unexpected fetch", { status: 599 });
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

async function actorFor(claims: JWTPayload): Promise<string> {
  const jwt = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "claims-kid" })
    .setIssuer(TEAM).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(signingKey);
  const result = await verifyAccess(new Request(`${BASE}/api/nodes`, { headers: { "cf-access-jwt-assertion": jwt } }), ENV);
  if (!result.ok) throw new Error(`access refused: ${result.response.status}`);
  return result.actor;
}

describe("Access actor claims", () => {
  it("takes common_name, then sub, then a fixed unknown actor when there is no email", async () => {
    expect(await actorFor({ common_name: "service-token.example.com", sub: "subject-1" })).toBe("service-token.example.com");
    expect(await actorFor({ sub: "subject-1" })).toBe("subject-1");
    expect(await actorFor({})).toBe("unknown");
  });
});

describe("Access configuration", () => {
  it("is absent when the team domain or audience is not set at all", () => {
    expect(accessConfig({} as Env)).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM } as Env)).toBeNull();
  });
});
