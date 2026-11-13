import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { GitHub, Response } from "../src/github.ts";
import type { Claims } from "../src/oidc.ts";
import type { Outcome, Target } from "../src/publish.ts";
import { handler, type Config } from "../src/server.ts";

const cfg: Config = { owners: ["sei-protocol"], workflow: "sei-protocol/seidroid/.github/workflows/review.yml", trunk: "main", team: "sei-protocol/eng", bots: ["dependabot[bot]"], checkName: "Seidroid Review" };
const HEAD = "b".repeat(40);
const MERGE = "f".repeat(40);
const claims = (over: Partial<Claims> = {}): Claims => ({
  repository: "sei-protocol/sei-chain", repository_owner: "sei-protocol", job_workflow_ref: `${cfg.workflow}@${"a".repeat(40)}`, job_workflow_sha: "a".repeat(40),
  workflow_ref: "sei-protocol/sei-chain/.github/workflows/seidroid.yml@refs/pull/7/merge", sha: MERGE,
  actor: "alice", event_name: "pull_request", ref: "refs/pull/7/merge", run_id: "9", run_attempt: "2", jti: Math.random().toString(), exp: Date.now() / 1000 + 300, ...over,
});

async function serve(routes: Record<string, (body?: any) => Response>) {
  const published: { target: Target; outcome: Outcome }[] = [];
  const tokens = new Map<string, Claims>();
  const gh: GitHub = {
    rest: async (method, path, body): Promise<any> => (routes[`${method} ${path}`] ?? (() => ({ status: 404, data: {} })))(body),
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
const base: Record<string, (body?: any) => Response> = {
  [`GET /repos/sei-protocol/seidroid/compare/${"a".repeat(40)}...main`]: ok({ status: "ahead" }),
  [`GET ${repo}/pulls/7`]: ok({ state: "open", head: { sha: HEAD, repo: { id: 1 } }, base: { sha: "c".repeat(40), repo: { id: 1 } }, user: { login: "bob" } }),
  [`GET ${repo}/contents/REVIEW.md?ref=${"c".repeat(40)}`]: ok({ content: Buffer.from("## Accepted\n- the legacy store keeps its lock\n").toString("base64") }),
  [`GET ${repo}/commits/${MERGE}`]: ok({ parents: [{ sha: "c".repeat(40) }, { sha: HEAD }] }),
  [`GET ${repo}/contents/.github/workflows/seidroid.yml?ref=${MERGE}`]: ok({ sha: "1".repeat(40) }),
  [`GET ${repo}/contents/.github/workflows/seidroid.yml?ref=${"c".repeat(40)}`]: ok({ sha: "1".repeat(40) }),
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
    assert.equal(target.aiReviewCheck, false);
    assert.equal(target.approve, false);
    assert.deepEqual(outcome.verdict.accepted, ["the legacy store keeps its lock"]);
    assert.equal(outcome.verdict.settledBy, "codex scout");

    await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission: { decision: "lgtm" } } });
    assert.match((s.published[1]!.outcome as { failure: string }).failure, /broke the contract/);

    for (const shadow of [false, true, undefined]) await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission }, shadow, aiReviewCheck: true });
    assert.deepEqual(s.published.slice(2).map((p) => p.target.aiReviewCheck), [true, false, false]);

    const own = { [`GET ${repo}/contents/docs/review.md?ref=${"c".repeat(40)}`]: ok({ content: Buffer.from("## Accepted\n- docs may lag\n").toString("base64") }) };
    const elsewhere = await serve({ ...base, ...own });
    try {
      await elsewhere.call("/publish", { pr: 7, head: HEAD, outcome: { submission }, approve: true, guidelines: "docs/review.md" });
      await elsewhere.call("/publish", { pr: 7, head: HEAD, outcome: { submission }, guidelines: "../secrets" });
      const [first, second] = elsewhere.published as { target: Target; outcome: any }[];
      assert.equal(first!.target.approve, true);
      assert.deepEqual([first!.outcome.verdict.accepted, second!.outcome.verdict.accepted], [["docs may lag"], ["the legacy store keeps its lock"]]);
    } finally {
      elsewhere.close();
    }

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
      [{ pr: 7, head: HEAD }, claims({ workflow_ref: "sei-protocol/sei-chain/.github/workflows/other.yml@refs/pull/7/merge" }), 403, /changes .github\/workflows\/other.yml/],
      [{ pr: 7, head: HEAD }, claims({ workflow_ref: "sei-protocol/other/.github/workflows/seidroid.yml@refs/pull/7/merge" }), 403, /changes sei-protocol\/other/],
      [{ pr: 7, head: HEAD }, claims({ sha: "e".repeat(40) }), 403, /changes .github\/workflows\/seidroid.yml/],
      [{ pr: 7, head: HEAD }, claims({ workflow_ref: "sei-protocol/sei-chain/.github/workflows/../x.yml@refs/pull/7/merge" }), 403, /changes .github\/workflows\/..\/x.yml/],
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

test("publish accepts a pull_request run from any unchanged workflow file", async () => {
  const file = `${repo}/contents/.github/workflows/AI%20Review%20%231.yaml`;
  const s = await serve({ ...base, [`GET ${file}?ref=${MERGE}`]: ok({ sha: "3".repeat(40) }), [`GET ${file}?ref=${"c".repeat(40)}`]: ok({ sha: "3".repeat(40) }) });
  try {
    const r = await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission } }, claims({ workflow_ref: "sei-protocol/sei-chain/.github/workflows/AI Review #1.yaml@refs/pull/7/merge" }));
    assert.equal(r.status, 200);
  } finally {
    s.close();
  }
});

test("publish refuses a pull_request run whose pull request changes its workflow", async () => {
  const caller = `GET ${repo}/contents/.github/workflows/seidroid.yml?ref=${"c".repeat(40)}`;
  for (const changed of [ok({ sha: "2".repeat(40) }), () => ({ status: 404, data: {} })]) {
    const s = await serve({ ...base, [caller]: changed });
    try {
      const r = await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission } });
      assert.equal(r.status, 403);
      assert.match(r.body.error, /changes .github\/workflows\/seidroid.yml/);
      assert.equal((await s.call("/publish", { pr: 7, head: HEAD, outcome: { submission } }, claims({ event_name: "issue_comment", ref: "refs/heads/main", actor: "dependabot[bot]" }))).status, 200);
    } finally {
      s.close();
    }
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

test("reply retries a post GitHub failed, unless the reply landed anyway", async () => {
  for (const landed of [false, true]) {
    let posts = 0;
    let existing: object[] = [];
    const s = await serve({
      ...base,
      "GET /orgs/sei-protocol/teams/eng/memberships/alice": ok({ state: "active" }),
      [`GET ${repo}/issues/comments/5`]: ok({ id: 5, user: { login: "alice" }, issue_url: `https://api.github.com${repo}/issues/7` }),
      [`GET ${repo}/issues/7/comments?per_page=100&page=1`]: () => ({ status: 200, data: existing }),
      [`POST ${repo}/issues/7/comments`]: (b: { body: string }) => {
        if (++posts > 1) return { status: 201, data: { html_url: "retried" } };
        if (landed) existing = [{ user: { login: "mallory" }, body: b.body, html_url: "x" }, { user: { login: "seidroid[bot]" }, body: b.body, html_url: "landed" }];
        return { status: 500, data: {} };
      },
    });
    try {
      const r = await s.call("/reply", { pr: 7, comment: 5, body: "Because." }, claims({ event_name: "issue_comment", ref: "refs/heads/main" }));
      assert.deepEqual([r.status, r.body, posts], landed ? [200, { url: "landed" }, 1] : [200, { url: "retried" }, 2]);
    } finally {
      s.close();
    }
  }
});

test("reply answers the asker's own comment in its thread, as the App", async () => {
  const posted: [string, string][] = [];
  const post = (where: string) => (body: { body: string }) => (posted.push([where, body.body]), { status: 201, data: { html_url: where } });
  const s = await serve({
    ...base,
    "GET /orgs/sei-protocol/teams/eng/memberships/alice": ok({ state: "active" }),
    "GET /orgs/sei-protocol/teams/eng/memberships/mallory": ok({ state: "pending" }),
    [`GET ${repo}/issues/comments/5`]: ok({ id: 5, user: { login: "alice" }, issue_url: `https://api.github.com${repo}/issues/7` }),
    [`GET ${repo}/issues/comments/6`]: ok({ id: 6, user: { login: "alice" }, issue_url: `https://api.github.com${repo}/issues/8` }),
    [`GET ${repo}/pulls/comments/9`]: ok({ id: 9, in_reply_to_id: 3, user: { login: "alice" }, pull_request_url: `https://api.github.com${repo}/pulls/7` }),
    [`GET ${repo}/pulls/7/reviews/4`]: ok({ id: 4, user: { login: "bob" } }),
    [`POST ${repo}/issues/7/comments`]: post("conversation"),
    [`POST ${repo}/pulls/7/comments/3/replies`]: post("thread"),
  });
  const asking = (event_name: string, actor = "alice") => claims({ event_name, actor, ref: "refs/heads/main" });
  try {
    const r = await s.call("/reply", { pr: 7, comment: 5, body: "Because." }, asking("issue_comment"));
    assert.deepEqual([r.status, r.body], [200, { url: "conversation" }]);
    assert.equal((await s.call("/reply", { pr: 7, comment: 9, body: "Inline." }, asking("pull_request_review_comment"))).status, 200);
    assert.deepEqual(posted.map(([where]) => where), ["conversation", "thread"]);
    assert.match(posted[0]![1], /^<!-- seidroid-reply -->\nBecause\.\n\n<sub>seidroid v2 · \[run\]\(https:\/\/github\.com\/sei-protocol\/sei-chain\/actions\/runs\/9\/attempts\/2\)<\/sub>$/);
    const refused: [unknown, Claims, number][] = [
      [{ pr: 7, comment: 6, body: "x" }, asking("issue_comment"), 403],
      [{ pr: 7, comment: 4, body: "x" }, asking("pull_request_review"), 403],
      [{ pr: 7, comment: 5, body: "x" }, asking("issue_comment", "mallory"), 403],
      [{ pr: 7, comment: 5, body: "x" }, asking("issue_comment", "dependabot[bot]"), 403],
      [{ pr: 7, comment: 5, body: "x" }, claims(), 403],
      [{ pr: 7, comment: 5, body: " " }, asking("issue_comment"), 400],
      [{ pr: 7, comment: 5, body: "ghp_" + "a".repeat(36) }, asking("issue_comment"), 422],
    ];
    for (const [body, c, status] of refused) assert.equal((await s.call("/reply", body, c)).status, status, JSON.stringify([body, c.actor, c.event_name]));
    assert.equal(posted.length, 2);
  } finally {
    s.close();
  }
});

test("react leaves one App reaction on the asker's comment for where the run got to", async () => {
  const reactions = new Map<string, { id: number; content: string; user: { login: string } }[]>();
  let next = 1;
  const at = (path: string) => reactions.get(path) ?? (reactions.set(path, []), reactions.get(path)!);
  const issue = `${repo}/issues/comments/5/reactions`;
  const code = `${repo}/pulls/comments/9/reactions`;
  at(issue).push({ id: next++, content: "eyes", user: { login: "alice" } });
  const routes: Record<string, (body?: any) => Response> = {
    ...base,
    "GET /orgs/sei-protocol/teams/eng/memberships/alice": ok({ state: "active" }),
    "GET /orgs/sei-protocol/teams/eng/memberships/mallory": ok({ state: "pending" }),
    [`GET ${repo}/issues/comments/5`]: ok({ id: 5, user: { login: "alice" }, issue_url: `https://api.github.com${repo}/issues/7` }),
    [`GET ${repo}/issues/comments/6`]: ok({ id: 6, user: { login: "bob" }, issue_url: `https://api.github.com${repo}/issues/7` }),
    [`GET ${repo}/pulls/comments/9`]: ok({ id: 9, user: { login: "alice" }, pull_request_url: `https://api.github.com${repo}/pulls/7` }),
  };
  for (const path of [issue, code]) {
    routes[`GET ${path}?per_page=100&page=1`] = () => ({ status: 200, data: at(path) });
    routes[`POST ${path}`] = (b: { content: string }) => {
      if (!at(path).some((r) => r.user.login === "seidroid[bot]" && r.content === b.content)) at(path).push({ id: next++, content: b.content, user: { login: "seidroid[bot]" } });
      return { status: 201, data: {} };
    };
    for (let id = 1; id <= 20; id++) routes[`DELETE ${path}/${id}`] = () => (reactions.set(path, at(path).filter((r) => r.id !== id)), { status: 204, data: {} });
  }
  const s = await serve(routes);
  const mine = (path: string) => at(path).filter((r) => r.user.login === "seidroid[bot]").map((r) => r.content);
  const asking = (event_name: string, actor = "alice") => claims({ event_name, actor, ref: "refs/heads/main" });
  try {
    for (const [state, want] of [["working", ["eyes"]], ["working", ["eyes"]], ["success", ["+1"]], ["failure", ["-1"]], ["none", []]] as const) {
      assert.equal((await s.call("/react", { pr: 7, comment: 5, state }, asking("issue_comment"))).status, 200, state);
      assert.deepEqual(mine(issue), want, state);
    }
    assert.ok(at(issue).some((r) => r.user.login === "alice"));
    await s.call("/react", { pr: 7, comment: 9, state: "working" }, asking("pull_request_review_comment"));
    await s.call("/react", { pr: 7, comment: 9, state: "success" }, asking("pull_request_review_comment"));
    assert.deepEqual(mine(code), ["+1"]);
    const refused: [unknown, Claims, number][] = [
      [{ pr: 7, comment: 5, state: "smile" }, asking("issue_comment"), 400],
      [{ pr: 7, comment: 4, state: "success" }, asking("pull_request_review"), 409],
      [{ pr: 7, comment: 6, state: "success" }, asking("issue_comment"), 403],
      [{ pr: 7, comment: 5, state: "success" }, asking("issue_comment", "mallory"), 403],
      [{ pr: 8, comment: 5, state: "success" }, asking("issue_comment"), 403],
    ];
    for (const [body, c, status] of refused) assert.equal((await s.call("/react", body, c)).status, status, JSON.stringify([body, c.actor, c.event_name]));
    assert.deepEqual(mine(issue), []);
  } finally {
    s.close();
  }
});
