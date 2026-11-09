import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { GitHub, Response } from "../src/github.ts";
import type { Claims } from "../src/oidc.ts";
import type { Outcome, Target } from "../src/publish.ts";
import { handler, type Config } from "../src/server.ts";

const cfg: Config = { owners: ["sei-protocol"], workflow: "sei-protocol/seidroid/.github/workflows/review.yml", trunk: "main", team: "sei-protocol/eng", bots: ["dependabot[bot]"], checkName: "seidroid review v2" };
const HEAD = "b".repeat(40);
const claims = (over: Partial<Claims> = {}): Claims => ({
  repository: "sei-protocol/sei-chain", repository_owner: "sei-protocol", job_workflow_ref: `${cfg.workflow}@${"a".repeat(40)}`, job_workflow_sha: "a".repeat(40),
  actor: "alice", event_name: "pull_request", ref: "refs/pull/7/merge", run_id: "9", run_attempt: "2", jti: Math.random().toString(), exp: Date.now() / 1000 + 300, ...over,
});

async function serve(routes: Record<string, () => Response>) {
  const published: { target: Target; outcome: Outcome }[] = [];
  const tokens = new Map<string, Claims>();
  const gh: GitHub = {
    rest: async (method, path): Promise<any> => (routes[`${method} ${path}`] ?? (() => ({ status: 404, data: {} })))(),
    graphql: async (): Promise<any> => ({}),
  };
  const h = handler(cfg, {
    verify: async (t) => tokens.get(t) ?? Promise.reject(new Error("bad signature")),
    github: async () => gh,
    bot: async () => "seidroid[bot]",
    publish: async (_gh, target, outcome) => (published.push({ target, outcome }), { conclusion: "success", inline: 0, file: 0, unplaced: 0, resolved: [], dismissed: 0 }),
  });
  const server = createServer((req, res) => void h(req, res)).listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, c: Claims | null = claims()) => {
    const token = c ? `t${tokens.size}` : "forged";
    if (c) tokens.set(token, c);
    const res = await fetch(url + path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { call, published, close: () => server.close(), url, tokens };
}

const ok = (data: object) => () => ({ status: 200, data });
const repo = "/repos/sei-protocol/sei-chain";
const base: Record<string, () => Response> = {
  [`GET /repos/sei-protocol/seidroid/compare/${"a".repeat(40)}...main`]: ok({ status: "ahead" }),
  [`GET ${repo}/pulls/7`]: ok({ state: "open", head: { sha: HEAD, repo: { id: 1 } }, base: { sha: "c".repeat(40), repo: { id: 1 } }, user: { login: "bob" } }),
  [`GET ${repo}/contents/REVIEW.md?ref=${"c".repeat(40)}`]: ok({ content: Buffer.from("## Accepted\n- the legacy store keeps its lock\n").toString("base64") }),
};
const submission = { read: 1, decision: "approve", summary: "Fine." };

test("publish rebuilds the verdict from the base commit and publishes as the run that asked", async () => {
  const s = await serve(base);
  try {
    const r = await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission, settledBy: "codex\nscout" } });
    assert.equal(r.status, 200);
    const [{ target, outcome }] = s.published as [{ target: Target; outcome: any }];
    assert.equal(target.runUrl, "https://github.com/sei-protocol/sei-chain/actions/runs/9/attempts/2");
    assert.equal(target.shadow, true);
    assert.deepEqual(outcome.verdict.accepted, ["the legacy store keeps its lock"]);
    assert.equal(outcome.verdict.settledBy, "codex scout");

    await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission: { decision: "lgtm" } } });
    assert.match((s.published[1]!.outcome as { failure: string }).failure, /broke the contract/);

    const asked = claims({ event_name: "issue_comment", ref: "refs/heads/main", actor: "dependabot[bot]" });
    assert.equal((await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission } }, asked)).status, 200);
  } finally {
    s.close();
  }
});

test("publish refuses tokens and requests it cannot trust", async () => {
  const s = await serve(base);
  try {
    const reused = claims();
    await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission } }, reused);
    const cases: [unknown, Claims | null, number, RegExp][] = [
      [{ pr: 7, head: HEAD }, null, 401, /bad signature/],
      [{ pr: 7, head: HEAD }, reused, 401, /already used/],
      [{ pr: 7, head: HEAD }, claims({ repository_owner: "evil" }), 403, /may not use/],
      [{ pr: 7, head: HEAD }, claims({ job_workflow_ref: "sei-protocol/sei-chain/.github/workflows/x.yml@main" }), 403, /is not/],
      [{ pr: 7, head: HEAD }, claims({ job_workflow_sha: "d".repeat(40) }), 403, /is not on/],
      [{ pr: 7, head: "e".repeat(40) }, claims(), 409, /is not on pull request/],
      [{ pr: -1, head: HEAD }, claims(), 400, /pr must be/],
      [{ pr: 7, head: "main" }, claims(), 400, /head must be/],
      [{ pr: 7, head: HEAD }, claims({ ref: "refs/pull/8/merge" }), 403, /not pull request 7/],
      [{ pr: 7, head: HEAD }, claims({ event_name: "issue_comment", ref: "refs/heads/main", actor: "mallory" }), 403, /not an active member/],
    ];
    for (const [body, c, status, err] of cases) {
      const r = await s.call("/publish", body, c);
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.match(r.body.error, err);
    }
    assert.equal(s.published.length, 1);
  } finally {
    s.close();
  }
});

test("publish refuses a pull request from a fork", async () => {
  const s = await serve({ ...base, [`GET ${repo}/pulls/7`]: ok({ state: "open", head: { sha: HEAD, repo: { id: 2 } }, base: { sha: "c".repeat(40), repo: { id: 1 } } }) });
  try {
    const r = await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission } });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /fork/);
  } finally {
    s.close();
  }
});

test("allow reports team membership of the actor and the author", async () => {
  const reacted: string[] = [];
  const s = await serve({
    ...base,
    "GET /orgs/sei-protocol/teams/eng/memberships/alice": ok({ state: "active" }),
    [`GET ${repo}/issues/comments/5`]: ok({ user: { login: "alice" } }),
    [`GET ${repo}/issues/comments/6`]: ok({ user: { login: "bob" } }),
    [`GET ${repo}/issues/comments/8`]: ok({ user: { login: "dependabot[bot]" } }),
    [`POST ${repo}/issues/comments/5/reactions`]: () => (reacted.push("alice"), { status: 201, data: {} }),
    [`POST ${repo}/issues/comments/6/reactions`]: () => (reacted.push("bob"), { status: 201, data: {} }),
    [`POST ${repo}/issues/comments/8/reactions`]: () => (reacted.push("dependabot[bot]"), { status: 201, data: {} }),
  });
  try {
    const r = await s.call("/allow", { pr: 7, comment: 5 });
    assert.deepEqual(r.body, { actor: true, author: false });
    await s.call("/allow", { pr: 7, comment: 6 });
    assert.deepEqual((await s.call("/allow", { pr: 7, comment: 5 }, claims({ actor: "mallory" }))).body, { actor: false, author: false });
    assert.deepEqual((await s.call("/allow", { pr: 7, comment: 8 }, claims({ actor: "dependabot[bot]" }))).body, { actor: true, author: false });
    assert.deepEqual(reacted, ["alice", "dependabot[bot]"]);
    const m = await (await fetch(`${s.url}/metrics`)).text();
    assert.match(m, /seidroid_requests_total\{route="POST \/allow",code="200"\} 4/);
  } finally {
    s.close();
  }
});
