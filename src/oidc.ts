import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

export const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_TTL_MS = 60 * 60 * 1000;
const LEEWAY_S = 60;

/** Claims is the part of a GitHub Actions OIDC token the service trusts. */
export interface Claims {
  repository: string;
  repository_owner: string;
  job_workflow_ref: string;
  job_workflow_sha: string;
  actor: string;
  event_name: string;
  ref: string;
  run_id: string;
  run_attempt: string;
  jti: string;
  exp: number;
}

type Jwk = JsonWebKey & { kid: string };
export type Keys = () => Promise<Jwk[]>;

/** githubKeys fetches GitHub Actions' signing keys, caching them for an hour. */
export function githubKeys(url = `${ISSUER}/.well-known/jwks`): Keys & { refresh(): void } {
  let cached: { at: number; keys: Jwk[] } | undefined;
  const keys = async () => {
    if (!cached || Date.now() - cached.at > JWKS_TTL_MS) {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`jwks: ${res.status}`);
      cached = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
    }
    return cached.keys;
  };
  return Object.assign(keys, { refresh: () => (cached = undefined) });
}

const part = (s: string): any => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** verifyToken checks an RS256 GitHub Actions token's signature, issuer, audience and lifetime, and returns its claims. */
export async function verifyToken(token: string, audience: string, keys: Keys, now = Date.now() / 1000): Promise<Claims> {
  const [h, p, s, extra] = token.split(".");
  if (!h || !p || !s || extra !== undefined) throw new Error("malformed token");
  const header = part(h);
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  let jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk && "refresh" in keys) {
    (keys as { refresh(): void }).refresh();
    jwk = (await keys()).find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("unknown signing key");
  if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"))) {
    throw new Error("bad signature");
  }
  const c = part(p);
  if (c.iss !== ISSUER) throw new Error("wrong issuer");
  if (c.aud !== audience && !(Array.isArray(c.aud) && c.aud.includes(audience))) throw new Error("wrong audience");
  if (typeof c.exp !== "number" || c.exp + LEEWAY_S < now || (typeof c.nbf === "number" && c.nbf - LEEWAY_S > now)) throw new Error("expired token");
  for (const k of ["repository", "repository_owner", "job_workflow_ref", "job_workflow_sha", "actor", "event_name", "ref", "run_id", "run_attempt", "jti"] as const) {
    if (typeof c[k] !== "string" || c[k] === "") throw new Error(`token has no ${k}`);
  }
  return c as Claims;
}
