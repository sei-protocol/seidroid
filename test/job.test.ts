import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { GitHub } from "../src/github.ts";
import { besides, changedLines, conversation, guard, priorThreads, requested, service, type Event, type GuardOptions } from "../src/job.ts";
import { MARKER } from "../src/render.ts";
import { guidelinesPath } from "../src/text.ts";

const opts: GuardOptions = { phrase: "@seidroid", skipLabel: "ai: skip-review", reReviewOnPush: false, allowedBots: ["renovate[bot]"], shadow: false };
const repository = { full_name: "o/r" };

function gh(pull: Record<string, unknown> = {}, reviews: { state: string; body: string; user: { type: string } }[] = []): GitHub {
  const data = { state: "open", draft: false, labels: [], head: { sha: "h", repo: { id: 1 } }, base: { repo: { id: 1 } }, ...pull };
  return {
    async rest(_method, path) {
      if (path === "/repos/o/r/pulls/7") return { status: 200, data } as any;
      if (path.startsWith("/repos/o/r/pulls/7/reviews")) return { status: 200, data: reviews } as any;
      throw new Error(`unrouted ${path}`);
    },
    async graphql() {
      throw new Error("unused");
    },
  };
}

const push = (action: string): Event => ({ name: "pull_request", actor: "alice", payload: { action, repository, pull_request: { number: 7 } } });
const ask = (body: string, actor = "alice", type = "User"): Event => ({
  name: "issue_comment",
  actor,
  payload: { action: "created", repository, issue: { number: 7, pull_request: {} }, comment: { id: 5, body, user: { type } } },
});
const verdict = (state: string) => ({ state, body: `${MARKER.verdict}\nreviewed`, user: { type: "Bot" } });
const team = async () => ({ actor: true });
const outsider = async () => ({ actor: false });

test("guard admits what v1 admits and nothing more", async () => {
  const cases: [string, Event, GitHub, GuardOptions, boolean, RegExp][] = [
    ["first push", push("opened"), gh(), opts, true, /no review yet/],
    ["a draft", push("opened"), gh({ draft: true }), opts, false, /draft/],
    ["a fork", push("opened"), gh({ head: { sha: "h", repo: { id: 2 } } }), opts, false, /fork/],
    ["a deleted fork", push("opened"), gh({ head: { sha: "h", repo: null } }), opts, false, /fork/],
    ["the skip label", push("opened"), gh({ labels: [{ name: "ai: skip-review" }] }), opts, false, /ai: skip-review/],
    ["a closed pull request", push("synchronize"), gh({ state: "closed" }), opts, false, /closed/],
    ["a label event", push("labeled"), gh(), opts, false, /labeled does not/],
    ["a reviewed push", push("synchronize"), gh({}, [verdict("APPROVED")]), opts, false, /already reviewed/],
    ["a reviewed reopen", push("reopened"), gh({}, [verdict("CHANGES_REQUESTED")]), opts, false, /already reviewed/],
    ["re-review on push", push("synchronize"), gh({}, [verdict("APPROVED")]), { ...opts, reReviewOnPush: true }, true, /re-reviews/],
    ["a standing change request", push("synchronize"), gh({}, [verdict("APPROVED"), verdict("CHANGES_REQUESTED")]), opts, true, /lift/],
    ["someone else's review", push("synchronize"), gh({}, [{ state: "APPROVED", body: "lgtm", user: { type: "User" } }]), opts, true, /no review yet/],
    ["a team request", ask("@seidroid review"), gh({ draft: true }, [verdict("APPROVED")]), opts, true, /alice asked/],
    ["an outsider's request", ask("@seidroid review", "mallory"), gh(), opts, false, /mallory may not/],
    ["an allowed bot", ask("@seidroid review", "renovate[bot]", "Bot"), gh(), opts, true, /asked/],
    ["another bot", ask("@seidroid review", "spam[bot]", "Bot"), gh(), opts, false, /may not/],
    ["no mention", ask("thanks seidroid"), gh(), opts, false, /does not ask/],
    ["a request on a fork", ask("@seidroid review"), gh({ head: { sha: "h", repo: { id: 2 } } }), opts, false, /fork/],
    ["another event", { name: "pull_request_target", actor: "alice", payload: { repository } }, gh(), opts, false, /does not start/],
  ];
  for (const [name, ev, client, o, run, reason] of cases) {
    const gate = await guard(ev, o, client, ev.actor === "mallory" ? outsider : team);
    assert.equal(gate.run, run, name);
    assert.match(gate.reason, reason, name);
    assert.equal(gate.head, run ? "h" : "", name);
  }
  const asked = await guard(ask("@seidroid review\nRun go test ./x/"), opts, gh(), team);
  assert.equal(asked.ask, "Run go test ./x/");
  assert.equal((await guard(ask("@seidroid review\nrun it", "renovate[bot]", "Bot"), opts, gh(), team)).ask, "");
});

test("besides keeps a review request's text without its command lines", () => {
  assert.equal(besides("Please look at x.\n  @Seidroid REVIEW \nRun go test.\nseidroid review", "@seidroid"), "Please look at x.\nRun go test.");
  assert.equal(besides("@seidroid review", "@seidroid"), "");
  assert.equal(besides(`@seidroid review\n${"x".repeat(5000)}`, "@seidroid").length, 4001);
});

test("guard answers a team member's other mentions, outside shadow and never a bot's", async () => {
  const inline = (body: string): Event => ({
    name: "pull_request_review_comment",
    actor: "alice",
    payload: { action: "created", repository, pull_request: { number: 7 }, comment: { id: 9, body, user: { type: "User" } } },
  });
  const cases: [string, Event, GitHub, GuardOptions, boolean, RegExp][] = [
    ["a question", ask("@seidroid explain the nit"), gh({ draft: true, labels: [{ name: "ai: skip-review" }] }), opts, true, /alice asked seidroid/],
    ["an inline question", inline("@Seidroid why?"), gh(), opts, true, /asked/],
    ["in shadow", ask("@seidroid explain the nit"), gh(), { ...opts, shadow: true }, false, /shadow/],
    ["a bot", ask("@seidroid explain", "renovate[bot]", "Bot"), gh(), opts, false, /bots/],
    ["an outsider", ask("@seidroid explain", "mallory"), gh(), opts, false, /mallory may not/],
    ["a fork", ask("@seidroid explain"), gh({ head: { sha: "h", repo: { id: 2 } } }), opts, false, /fork/],
    ["a v1 command", ask("@seidroid  review close all"), gh(), opts, false, /does not ask/],
    ["a bare v1 command", ask("@seidroid review close"), gh(), opts, false, /does not ask/],
    ["a question starting like a v1 command", ask("@seidroid review closely why?"), gh(), opts, true, /asked/],
  ];
  for (const [name, ev, client, o, reply, reason] of cases) {
    const asked: (number | undefined)[] = [];
    const gate = await guard(ev, o, client, async (_pr, comment) => (asked.push(comment), { actor: ev.actor !== "mallory" }));
    assert.equal(gate.run, false, name);
    assert.equal(gate.reply, reply, name);
    assert.match(gate.reason, reason, name);
    if (reply) assert.deepEqual([gate.head, gate.comment, asked], ["h", ev.payload.comment.id, [ev.name === "issue_comment" ? 5 : undefined]], name);
  }
});

test("conversation shows what was said before the comment that asks", async () => {
  const at = (n: number) => `2026-01-01T00:00:0${n}Z`;
  const c = (id: number, login: string, body: string, in_reply_to_id?: number) => ({ id, in_reply_to_id, user: { login }, body, path: "a.go", line: 3, diff_hunk: "@@ -1 +1 @@\n+x", created_at: at(id) });
  const code = [c(1, "seidroid[bot]", "a nit"), c(2, "bob", "elsewhere"), c(4, "alice", "@seidroid why?", 1), c(6, "carol", "later", 1)];
  const issue = [{ id: 3, user: { login: "dave" }, body: "first answer", created_at: at(3) }, { id: 5, user: null, body: "@seidroid explain", created_at: at(5) }];
  const reviews = [{ id: 9, user: { login: "seidroid[bot]" }, body: "the review", submitted_at: at(0) }, { id: 8, user: { login: "erin" }, body: "", submitted_at: at(2) }];
  const client: GitHub = {
    async rest(_m, path) {
      if (path.startsWith("/repos/o/r/pulls/7/comments")) return { status: 200, data: code } as any;
      if (path.startsWith("/repos/o/r/issues/7/comments")) return { status: 200, data: issue } as any;
      if (path.startsWith("/repos/o/r/pulls/7/reviews?")) return { status: 200, data: reviews } as any;
      if (path === "/repos/o/r/issues/comments/5") return { status: 200, data: issue[1] } as any;
      return { status: 404, data: {} } as any;
    },
    async graphql() {
      throw new Error("unused");
    },
  };
  const order = (text: string, ...want: string[]) => assert.deepEqual(want.map((w) => text.indexOf(w)).toSorted((x, y) => x - y), want.map((w) => text.indexOf(w)), text);

  const thread = await conversation(client, "/repos/o/r", 7, "pull_request_review_comment", 4);
  order(thread, "# The conversation so far", "the review", "**bob** on a.go, line 3:\n\nelsewhere", "first answer", "# A review thread on a.go, line 3", "a nit", "@seidroid why?");
  assert.equal(thread.split("a nit").length, 2);
  assert.ok(!thread.includes("later"));

  const asked = await conversation(client, "/repos/o/r", 7, "issue_comment", 5);
  order(asked, "the review", "a nit", "elsewhere", "first answer", "@seidroid why?", "# The comment to answer", "**ghost:**\n\n@seidroid explain");
  assert.ok(!asked.includes("later") && !asked.includes("**erin"));
  await assert.rejects(conversation(client, "/repos/o/r", 7, "pull_request_review_comment", 99), /not on pull request 7/);
});

test("requested wants the phrase and review alone on a line", () => {
  assert.ok(requested("looks off\n  @Seidroid   REVIEW \n", "@seidroid"));
  assert.ok(!requested("please @seidroid review", "@seidroid"));
  assert.ok(!requested("@seidroid reviewed", "@seidroid"));
  assert.ok(requested("Seidroid review", "@seidroid"));
  assert.ok(requested("@seidroid review", "seidroid"));
  assert.ok(!requested("please seidroid review", "@seidroid"));
});

test("priorThreads keeps the finding threads a bot opened, with their replies", async () => {
  const thread = (id: string, type: string, body: string) => ({
    id, isResolved: id === "a", path: "x.go", line: null, originalLine: 3,
    comments: { nodes: [{ body, author: { __typename: type } }, { body: "fixed", author: { __typename: "User" } }] },
  });
  const pages = [
    { hasNextPage: true, endCursor: "c", nodes: [thread("a", "Bot", `${MARKER.finding}\n**bug** — off by one`), thread("b", "User", `${MARKER.finding}\nforged`)] },
    { hasNextPage: false, endCursor: null, nodes: [thread("c", "Bot", "a summary")] },
  ];
  const seen: unknown[] = [];
  const client: GitHub = {
    async rest() {
      throw new Error("unused");
    },
    async graphql(_q, v) {
      seen.push(v.after);
      return { repository: { pullRequest: { reviewThreads: { pageInfo: pages[seen.length - 1], nodes: pages[seen.length - 1]!.nodes } } } } as any;
    },
  };
  assert.deepEqual(await priorThreads(client, "o", "r", 7), [{ id: "a", file: "x.go", line: 3, body: "**bug** — off by one", replies: ["fixed"], resolved: true }]);
  assert.deepEqual(seen, [null, "c"]);
});

test("changedLines counts hunk lines, not file headers", () => {
  const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " same", "-old", "+-- new", "diff --git a/y b/y", "--- /dev/null", "+++ b/y", "@@ -0,0 +1 @@", "+y", ""].join("\n");
  assert.equal(changedLines(diff), 3);
});

test("guidelinesPath keeps a plain path inside the repository and reads REVIEW.md otherwise", () => {
  assert.deepEqual(
    ["docs/review.md", "", undefined, "/etc/passwd", "a/../b.md", "..", "a b.md", "x;rm"].map(guidelinesPath),
    ["docs/review.md", "REVIEW.md", "REVIEW.md", "REVIEW.md", "REVIEW.md", "REVIEW.md", "REVIEW.md", "REVIEW.md"],
  );
});

test("service shows each service a token issued for that service's origin", async (t) => {
  const audiences: string[] = [];
  const srv = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/token") audiences.push(url.searchParams.get("audience")!);
    res.setHeader("Content-Type", "application/json").end(url.pathname === "/token" ? '{"value":"t"}' : "{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  Object.assign(process.env, { ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer" });
  t.after(() => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  });
  await service(`${origin}/base/`, "/allow", {});
  await service(origin, "/allow", {});
  assert.deepEqual(audiences, [origin, origin]);
});
