import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { ISSUER, verifyToken } from "../src/oidc.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = async () => [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }];
const now = 1_800_000_000;
const good = {
  iss: ISSUER, aud: "seidroid", exp: now + 300, nbf: now - 10, repository: "sei-protocol/sei-chain", repository_owner: "sei-protocol",
  job_workflow_ref: "sei-protocol/seidroid/.github/workflows/review.yml@refs/heads/main", job_workflow_sha: "a".repeat(40),
  actor: "alice", event_name: "pull_request", ref: "refs/pull/7/merge", run_id: "9", run_attempt: "1", jti: "j1",
};

function jwt(claims: object, header: object = { alg: "RS256", kid: "k1" }): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc(header)}.${enc(claims)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}

test("verifyToken accepts a well-signed GitHub Actions token for the audience", async () => {
  assert.equal((await verifyToken(jwt(good), "seidroid", keys, now)).repository, "sei-protocol/sei-chain");
});

test("verifyToken refuses forged, foreign, stale and incomplete tokens", async () => {
  const forged = jwt(good).replace(/\.[^.]+$/, "." + Buffer.from("x").toString("base64url"));
  const cases: [string, RegExp][] = [
    [forged, /bad signature/],
    [jwt({ ...good, iss: "https://evil" }), /wrong issuer/],
    [jwt({ ...good, aud: "other" }), /wrong audience/],
    [jwt({ ...good, exp: now - 120 }), /expired/],
    [jwt({ ...good, nbf: now + 120 }), /expired/],
    [jwt({ ...good, jti: "" }), /no jti/],
    [jwt(good, { alg: "none", kid: "k1" }), /unexpected alg/],
    [jwt(good, { alg: "RS256", kid: "k2" }), /unknown signing key/],
    ["a.b", /malformed/],
  ];
  for (const [token, err] of cases) await assert.rejects(verifyToken(token, "seidroid", keys, now), err);
});
