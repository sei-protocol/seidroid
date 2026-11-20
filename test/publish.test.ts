import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitHub, Response } from "../src/github.ts";
import { publish, type Target } from "../src/publish.ts";
import { MARKER } from "../src/render.ts";
import { parseSubmission, verdictOf, type Verdict } from "../src/verdict.ts";

const T: Target = { owner: "o", repo: "r", pr: 7, head: "abc", bot: "seidroid[bot]", runUrl: "https://run/1", checkName: "Seidroid Review", includeNits: false, shadow: false, aiReviewCheck: false, approve: true };
const patch = "@@ -1,2 +1,3 @@\n a\n+b\n c";

type Route = (body: any) => Response;

/** fake answers GitHub calls from routes keyed "METHOD path" (the query string dropped) and records every call. */
type Thread = { id: string; body: string; login?: string; resolved?: boolean; path?: string; line?: number | null; outdated?: boolean; side?: string };

function fake(routes: Record<string, Route>, threads: Thread[] = [], replyFails = false) {
  const calls: { key: string; body: any }[] = [];
  const base: Record<string, Route> = {
    "GET /repos/o/r/pulls/7": () => ({ status: 200, data: { changed_files: 1, head: { sha: "abc" } } }),
    "GET /repos/o/r/pulls/7/files": () => ({ status: 200, data: [{ filename: "a.go", patch }] }),
    "GET /repos/o/r/issues/7/comments": () => ({ status: 200, data: [] }),
    "GET /repos/o/r/pulls/7/reviews": () => ({ status: 200, data: [] }),
    "POST /repos/o/r/pulls/7/reviews": () => ({ status: 200, data: {} }),
    "POST /repos/o/r/pulls/7/comments": () => ({ status: 201, data: {} }),
    "POST /repos/o/r/check-runs": () => ({ status: 201, data: {} }),
    ...routes,
  };
  const gh: GitHub = {
    async rest(method, path, body) {
      const key = `${method} ${path.split("?")[0]}`;
      calls.push({ key, body });
      const route = base[key] ?? base[key.replace(/\/\d+(\/dismissals)?$/, "/:id$1")];
      if (!route) throw new Error(`unrouted ${key}`);
      return route(body);
    },
    async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
      const key = query.includes("resolveReviewThread") ? "resolve" : query.includes("addPullRequestReviewThreadReply") ? "reply" : "threads";
      calls.push({ key, body: variables });
      if (key === "reply" && replyFails) throw new Error("graphql: 502");
      if (key !== "threads") return {};
      const nodes = threads.map((th) => ({
        id: th.id, isResolved: th.resolved ?? false, isOutdated: th.outdated ?? false, path: th.path ?? "a.go", line: th.line === undefined ? 2 : th.line, diffSide: th.side ?? "RIGHT",
        comments: { nodes: [{ body: th.body, author: { login: th.login ?? "seidroid" } }] },
      }));
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } };
    },
  };
  return { gh, calls, of: (key: string) => calls.filter((c) => c.key === key).map((c) => c.body) };
}

function verdict(raw: object): Verdict {
  const parsed = parseSubmission({ read: 3, decision: "approve", summary: "Adds b.", ...raw });
  assert.ok(parsed.ok);
  return verdictOf(parsed.submission);
}

const comment = (over: object = {}) => ({ path: "a.go", line: 2, severity: "blocker", body: "b panics", ...over });

test("publish posts anchored findings in the review and the rest on their file", async () => {
  const { gh, of } = fake({});
  const v = verdict({ inline_comments: [comment(), comment({ line: 9, body: "off the hunk" })] });
  const r = await publish(gh, T, { verdict: v });
  const [review] = of("POST /repos/o/r/pulls/7/reviews");
  assert.equal(review.event, "REQUEST_CHANGES");
  assert.deepEqual(review.comments.map((c: any) => c.line), [2]);
  assert.ok(review.body.startsWith(MARKER.verdict));
  assert.equal(of("POST /repos/o/r/pulls/7/comments")[0].subject_type, "file");
  assert.equal(of("POST /repos/o/r/check-runs")[0].conclusion, "failure");
  assert.deepEqual({ inline: r.inline, file: r.file, unplaced: r.unplaced }, { inline: 1, file: 1, unplaced: 0 });
});

test("publish falls back one comment at a time, then to the body, when GitHub refuses the review", async () => {
  let reviews = 0;
  const { gh, of } = fake({
    "POST /repos/o/r/pulls/7/reviews": () => (++reviews < 3 ? { status: 422, data: {} } : { status: 200, data: {} }),
    "POST /repos/o/r/pulls/7/comments": () => ({ status: 422, data: {} }),
  });
  const r = await publish(gh, T, { verdict: verdict({ inline_comments: [comment({ severity: "suggestion" })] }) });
  const posted = of("POST /repos/o/r/pulls/7/reviews");
  assert.deepEqual(posted.map((p: any) => [p.event, p.comments.length]), [["APPROVE", 1], ["APPROVE", 0], ["COMMENT", 0]]);
  assert.match(posted[2].body, /`a.go:2` — b panics/);
  assert.equal(r.unplaced, 1);
});

test("publish treats a review an ambiguous failure still posted as posted", async () => {
  const { gh, of } = fake({
    "POST /repos/o/r/pulls/7/reviews": () => ({ status: 502, data: {} }),
    "GET /repos/o/r/pulls/7/reviews": () => ({ status: 200, data: [{ id: 1, commit_id: "abc", state: "APPROVED", body: `${MARKER.verdict} [run](https://run/1)`, user: { login: "seidroid[bot]" } }] }),
  });
  await publish(gh, T, { verdict: verdict({}) });
  assert.equal(of("POST /repos/o/r/pulls/7/reviews").length, 1);
  assert.equal(of("POST /repos/o/r/check-runs")[0].conclusion, "success");
  await assert.rejects(publish(gh, { ...T, runUrl: "https://run" }, { verdict: verdict({}) }), /could not post the review: 502/);
});

test("publish never posts a finding again after a comment failed ambiguously", async () => {
  const { gh, of } = fake({ "POST /repos/o/r/pulls/7/comments": () => ({ status: 502, data: {} }) });
  const r = await publish(gh, T, { verdict: verdict({ inline_comments: [comment({ line: 9 })] }) });
  assert.equal(of("POST /repos/o/r/pulls/7/comments").length, 1);
  assert.equal(r.unplaced, 1);
});

test("publish anchors nothing on a file list GitHub cut short", async () => {
  const { gh, of } = fake({ "GET /repos/o/r/pulls/7": () => ({ status: 200, data: { changed_files: 2, head: { sha: "abc" } } }) });
  await publish(gh, T, { verdict: verdict({ inline_comments: [comment()] }) });
  assert.equal(of("POST /repos/o/r/pulls/7/reviews")[0].comments.length, 0);
  assert.equal(of("POST /repos/o/r/pulls/7/comments")[0].subject_type, "file");
});

test("publish resolves only its own threads, superseded ones once the restatement lands, and their duplicates", async () => {
  const own = `${MARKER.finding}\n**blocker** — old`;
  const { gh, of } = fake({}, [
    { id: "T1", body: own, line: 30 },
    { id: "T2", body: own, line: 30 },
    { id: "T3", body: `${MARKER.finding}\n**nit** — other` },
    { id: "T4", body: `${MARKER.finding}\n**nit** — human`, login: "mallory" },
    { id: "T5", body: `${MARKER.finding}\n**nit** — gone`, line: 40 },
  ]);
  const v = verdict({ inline_comments: [comment({ severity: "suggestion", supersedes_thread_ids: ["T1"] }), comment({ line: 9, supersedes_thread_ids: ["T5"] }), comment({ line: 41, body: "near T5" })], resolved_thread_ids: ["T3", "T4"] });
  const r = await publish(gh, T, { verdict: v });
  assert.equal(of("reply").length, 0);
  assert.deepEqual(r.resolved.sort(), ["T1", "T2", "T3", "T5"]);
  assert.deepEqual(of("resolve").map((b: any) => b.id).sort(), ["T1", "T2", "T3", "T5"]);
});

test("publish keeps a superseded thread open when its restatement landed nowhere", async () => {
  const { gh } = fake({ "POST /repos/o/r/pulls/7/comments": () => ({ status: 422, data: {} }) }, [{ id: "T5", body: `${MARKER.finding}\nx`, line: 40 }]);
  const r = await publish(gh, T, { verdict: verdict({ inline_comments: [comment({ line: 9, supersedes_thread_ids: ["T5"] })] }) });
  assert.deepEqual(r.resolved, []);
  assert.equal(r.unplaced, 1);
});

test("publish dismisses its own stale change requests once the head is clean", async () => {
  const stale = (id: number, login: string, body: string = MARKER.verdict) => ({ id, state: "CHANGES_REQUESTED", body, commit_id: "old", user: { login } });
  const { gh, of } = fake({
    "GET /repos/o/r/pulls/7/reviews": () => ({ status: 200, data: [stale(1, "seidroid[bot]"), stale(2, "alice"), stale(3, "seidroid[bot]", "hand written")] }),
    "PUT /repos/o/r/pulls/7/reviews/:id/dismissals": () => ({ status: 200, data: {} }),
  });
  const r = await publish(gh, T, { verdict: verdict({}) });
  assert.equal(r.dismissed, 1);
  assert.equal(of("PUT /repos/o/r/pulls/7/reviews/1/dismissals").length, 1);

  const moved = fake({ "GET /repos/o/r/pulls/7": () => ({ status: 200, data: { changed_files: 1, head: { sha: "new" } } }) });
  assert.equal((await publish(moved.gh, T, { verdict: verdict({}) })).dismissed, 0);
});

test("publish reports no verdict, replacing its earlier notice, and refuses a review naming a secret", async () => {
  const { gh, of } = fake({
    "GET /repos/o/r/issues/7/comments": () => ({ status: 200, data: [{ id: 5, body: `${MARKER.noVerdict}\nold`, user: { login: "seidroid[bot]" } }, { id: 6, body: `${MARKER.noVerdict}`, user: { login: "bob" } }] }),
    "DELETE /repos/o/r/issues/comments/:id": () => ({ status: 204, data: undefined }),
    "POST /repos/o/r/issues/7/comments": () => ({ status: 201, data: {} }),
  });
  await publish(gh, T, { verdict: verdict({ summary: "found ghp_" + "a".repeat(36) }) });
  assert.equal(of("POST /repos/o/r/pulls/7/reviews").length, 0);
  assert.match(of("POST /repos/o/r/issues/7/comments")[0].body, /shaped like a github token/);
  assert.equal(of("DELETE /repos/o/r/issues/comments/5").length, 1);
  assert.equal(of("DELETE /repos/o/r/issues/comments/6").length, 0);
  assert.equal(of("POST /repos/o/r/check-runs")[0].output.title, "No verdict");

  const settled = fake({ "POST /repos/o/r/issues/7/comments": () => ({ status: 201, data: {} }) });
  await publish(settled.gh, T, { verdict: { ...verdict({}), settledBy: "ghp_" + "b".repeat(36) } });
  assert.equal(settled.of("POST /repos/o/r/pulls/7/reviews").length, 0);

  const accepted = fake({ "POST /repos/o/r/issues/7/comments": () => ({ status: 201, data: {} }) });
  await publish(accepted.gh, T, { verdict: { ...verdict({}), accepted: ["key ghp_" + "c".repeat(36)] } });
  assert.equal(accepted.of("POST /repos/o/r/pulls/7/reviews").length, 0);
});

test("publish copies the check run as AI Review when asked, and survives the copy failing", async () => {
  const names = (of: (k: string) => any[]) => of("POST /repos/o/r/check-runs").map((c) => `${c.name}: ${c.conclusion}`);
  const plain = fake({});
  await publish(plain.gh, T, { verdict: verdict({}) });
  assert.deepEqual(names(plain.of), ["Seidroid Review: success"]);

  const copied = fake({ "POST /repos/o/r/issues/7/comments": () => ({ status: 201, data: {} }) });
  await publish(copied.gh, { ...T, aiReviewCheck: true }, { verdict: verdict({}) });
  await publish(copied.gh, { ...T, aiReviewCheck: true }, { failure: "pi exited with 1" });
  assert.deepEqual(names(copied.of), ["Seidroid Review: success", "AI Review: success", "Seidroid Review: failure", "AI Review: failure"]);

  const refused = fake({ "POST /repos/o/r/check-runs": (b) => ({ status: b.name === "AI Review" ? 403 : 201, data: {} }) });
  assert.equal((await publish(refused.gh, { ...T, aiReviewCheck: true }, { verdict: verdict({}) })).conclusion, "success");
});

test("publish in shadow mode posts only the check run", async () => {
  const { gh, calls } = fake({});
  await publish(gh, { ...T, shadow: true }, { verdict: verdict({ inline_comments: [comment(), comment({ line: 9 })] }) });
  assert.deepEqual(calls.filter((c) => !c.key.startsWith("GET") && c.key !== "threads").map((c) => c.key), ["POST /repos/o/r/check-runs"]);
  const { output } = calls.find((c) => c.key === "POST /repos/o/r/check-runs")!.body;
  assert.match(output.summary, /`a.go:2` — b panics/);
  assert.match(output.text, /^<!-- seidroid-review:findings \{"pr":7,"findings":\[\{"file":"a.go","line":2,"severity":"blocker","detail":"b panics"\}/);
  await publish(gh, { ...T, shadow: true }, { failure: "pi exited with 1" });
  assert.equal(calls.filter((c) => c.key === "POST /repos/o/r/issues/7/comments").length, 0);
});

test("publish only comments on a clean review unless it may approve, and still requests changes", async () => {
  const events = async (approve: boolean, raw: object) => {
    const { gh, of } = fake({});
    await publish(gh, { ...T, approve }, { verdict: verdict(raw) });
    return of("POST /repos/o/r/pulls/7/reviews").map((r: any) => r.event);
  };
  assert.deepEqual(await events(false, {}), ["COMMENT"]);
  assert.deepEqual(await events(true, {}), ["APPROVE"]);
  assert.deepEqual(await events(false, { inline_comments: [comment()] }), ["REQUEST_CHANGES"]);
});

test("publish restates a finding in its own open thread that carries it instead of opening another", async () => {
  const { gh, of } = fake({}, [
    { id: "SAME", body: `${MARKER.finding}\n**suggestion** — b panics\n\n_Cited at \`a.go:40\`, outside this diff's changed lines._`, line: null },
    { id: "NEAR", body: `${MARKER.finding}\n**blocker** — reads count as admission`, line: 5 },
    { id: "OLD", body: `${MARKER.finding}\n**blocker** — e leaks`, line: null, outdated: true },
    { id: "WANT", body: `${MARKER.finding}\n**blocker** — g leaks`, line: 30 },
    { id: "BOT", body: `${MARKER.finding}\n**blocker** — c leaks`, login: "other-bot" },
    { id: "LEFT", body: `${MARKER.finding}\n**blocker** — d leaks`, side: "LEFT" },
    { id: "FAR", body: `${MARKER.finding}\n**blocker** — d leaks`, line: 9 },
  ]);
  const v = verdict({
    inline_comments: [comment(), comment({ line: 31, body: "h leaks" }), comment({ line: 29, body: "g is shared", supersedes_thread_ids: ["WANT"] }),
      comment({ line: 3, body: "reads are admission", supersedes_thread_ids: ["NEAR"] }), comment({ body: "c leaks" }), comment({ line: 30, body: "e leaks" })],
  });
  const r = await publish(gh, T, { verdict: v });
  assert.deepEqual(of("reply").map((b: any) => b.id), ["WANT", "NEAR", "SAME"]);
  assert.match(of("reply")[2].body, /^\*\*blocker\*\* — b panics\n\n_The review of `abc` finds this again at `a.go:2`._$/);
  assert.deepEqual(of("POST /repos/o/r/pulls/7/reviews")[0].comments.map((c: any) => c.body.split(" — ")[1]), ["c leaks"]);
  assert.deepEqual(of("POST /repos/o/r/pulls/7/comments").map((c: any) => c.body.split(" — ")[1].split("\n")[0]), ["h leaks", "e leaks"]);
  assert.deepEqual(r.resolved, []);
  assert.deepEqual({ replied: r.replied, inline: r.inline, unplaced: r.unplaced }, { replied: 3, inline: 1, unplaced: 0 });
});

test("publish replies a nearby finding only into a thread of its severity, closest first", async () => {
  const { gh, of } = fake({}, [{ id: "T", body: `${MARKER.finding}\n**blocker** — old wording`, line: 10 }, { id: "N", body: `${MARKER.finding}\n**nit** — style`, line: 20 }]);
  const v = verdict({ inline_comments: [comment({ line: 12, body: "farther" }), comment({ line: 11, body: "closer" }), comment({ line: 20, body: "unrelated" })] });
  const r = await publish(gh, T, { verdict: v });
  assert.deepEqual(of("reply").map((b: any) => [b.id, b.body.split(" — ")[1].split("\n")[0]]), [["T", "closer"]]);
  assert.equal(r.replied, 1);
});

test("publish opens no thread for a finding whose reply may not have landed, and replies nowhere in shadow", async () => {
  const thread = [{ id: "T1", body: `${MARKER.finding}\n**blocker** — old` }];
  const failed = fake({}, thread, true);
  const r = await publish(failed.gh, T, { verdict: verdict({ inline_comments: [comment()] }) });
  assert.equal(failed.of("POST /repos/o/r/pulls/7/reviews")[0].comments.length, 0);
  assert.match(failed.of("POST /repos/o/r/pulls/7/reviews")[0].body, /`a.go:2` — b panics/);
  assert.deepEqual({ replied: r.replied, unplaced: r.unplaced }, { replied: 0, unplaced: 1 });

  const addressed = fake({}, thread);
  await publish(addressed.gh, T, { verdict: verdict({ inline_comments: [comment()], resolved_thread_ids: ["T1"] }) });
  assert.equal(addressed.of("reply").length, 0);
  assert.equal(addressed.of("POST /repos/o/r/pulls/7/reviews")[0].comments.length, 1);

  const shadow = fake({}, thread);
  await publish(shadow.gh, { ...T, shadow: true }, { verdict: verdict({ inline_comments: [comment()] }) });
  assert.equal(shadow.of("reply").length, 0);
});

test("publish posts nothing on the code and never approves once the head has moved past the commit reviewed", async () => {
  const moved = () => fake({ "GET /repos/o/r/pulls/7": () => ({ status: 200, data: { changed_files: 1, head: { sha: "def" } } }) }, [{ id: "T1", body: `${MARKER.finding}\n**nit** — old` }]);
  const clean = moved();
  const r = await publish(clean.gh, T, { verdict: verdict({ inline_comments: [comment({ severity: "suggestion" }), comment({ line: 9, severity: "suggestion" })], resolved_thread_ids: ["T1"] }) });
  const [review] = clean.of("POST /repos/o/r/pulls/7/reviews");
  assert.deepEqual([review.event, review.commit_id, review.comments], ["COMMENT", "abc", []]);
  assert.match(review.body, /^<!-- seidroid-review -->\n\*\*The head moved during this review.\*\* It read `abc`, but the pull request is now at `def`/);
  assert.match(review.body, /`a.go:2` — b panics/);
  assert.deepEqual([clean.of("POST /repos/o/r/pulls/7/comments").length, clean.of("reply").length, clean.of("resolve").length], [0, 0, 0]);
  assert.deepEqual({ moved: r.moved, unplaced: r.unplaced, dismissed: r.dismissed }, { moved: "def", unplaced: 2, dismissed: 0 });

  const blocked = moved();
  await publish(blocked.gh, T, { verdict: verdict({ inline_comments: [comment()] }) });
  assert.deepEqual(blocked.of("POST /repos/o/r/pulls/7/reviews").map((x: any) => [x.event, x.comments.length]), [["REQUEST_CHANGES", 0]]);
});

test("publish withdraws an approval, and resolves nothing, when the head moved or went unread while it was posted", async () => {
  const approving = (heads: (string | null)[], dismissal = 200) => fake({
    "GET /repos/o/r/pulls/7": () => {
      const sha = heads.length ? heads.shift()! : "def";
      return sha === null ? { status: 502, data: {} } : { status: 200, data: { changed_files: 1, head: { sha } } };
    },
    "POST /repos/o/r/pulls/7/reviews": () => ({ status: 200, data: { id: 9, state: "APPROVED" } }),
    "PUT /repos/o/r/pulls/7/reviews/:id/dismissals": () => ({ status: dismissal, data: { message: "no" } }),
  }, [{ id: "T1", body: `${MARKER.finding}\n**blocker** — old` }]);
  const addressed = verdict({ resolved_thread_ids: ["T1"] });

  const moved = approving(["abc", "def"]);
  const r = await publish(moved.gh, T, { verdict: addressed });
  assert.equal(moved.of("POST /repos/o/r/pulls/7/reviews")[0].event, "APPROVE");
  assert.match(moved.of("PUT /repos/o/r/pulls/7/reviews/9/dismissals")[0].message, /^Withdrawn: the head moved/);
  assert.equal(moved.of("resolve").length, 0);
  assert.deepEqual({ moved: r.moved, dismissed: r.dismissed, resolved: r.resolved }, { moved: "def", dismissed: 0, resolved: [] });

  const unread = approving(["abc", null]);
  assert.equal((await publish(unread.gh, T, { verdict: addressed })).moved, "unknown");
  assert.equal(unread.of("PUT /repos/o/r/pulls/7/reviews/9/dismissals").length, 1);

  const refused = approving(["abc", "def"], 422);
  await assert.rejects(publish(refused.gh, T, { verdict: addressed }), /could not withdraw the approval of abc: 422 no/);
  assert.equal(refused.of("resolve").length, 0);

  const still = approving(["abc", "abc"]);
  assert.equal((await publish(still.gh, T, { verdict: addressed })).moved, "");
  assert.equal(still.of("PUT /repos/o/r/pulls/7/reviews/9/dismissals").length, 0);
  assert.equal(still.of("resolve").length, 1);
});
