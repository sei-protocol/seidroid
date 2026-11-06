import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitHub, Response } from "../src/github.ts";
import { publish, type Target } from "../src/publish.ts";
import { MARKER } from "../src/render.ts";
import { parseSubmission, verdictOf, type Verdict } from "../src/verdict.ts";

const T: Target = { owner: "o", repo: "r", pr: 7, head: "abc", bot: "seidroid[bot]", runUrl: "https://run/1", checkName: "seidroid review v2", includeNits: false, shadow: false };
const patch = "@@ -1,2 +1,3 @@\n a\n+b\n c";

type Route = (body: any) => Response;

/** fake answers GitHub calls from routes keyed "METHOD path" (the query string dropped) and records every call. */
function fake(routes: Record<string, Route>, threads: { id: string; body: string; login?: string; resolved?: boolean }[] = []) {
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
      calls.push({ key: query.includes("resolveReviewThread") ? "resolve" : "threads", body: variables });
      if (query.includes("resolveReviewThread")) return {};
      const nodes = threads.map((th) => ({ id: th.id, isResolved: th.resolved ?? false, comments: { nodes: [{ body: th.body, author: { login: th.login ?? "seidroid" } }] } }));
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
    { id: "T1", body: own },
    { id: "T2", body: own },
    { id: "T3", body: `${MARKER.finding}\n**nit** — other` },
    { id: "T4", body: `${MARKER.finding}\n**nit** — human`, login: "mallory" },
    { id: "T5", body: `${MARKER.finding}\n**nit** — gone` },
  ]);
  const v = verdict({ inline_comments: [comment({ severity: "suggestion", supersedes_thread_ids: ["T1"] }), comment({ line: 9, supersedes_thread_ids: ["T5"] })], resolved_thread_ids: ["T3", "T4"] });
  const r = await publish(gh, T, { verdict: v });
  assert.deepEqual(r.resolved.sort(), ["T1", "T2", "T3", "T5"]);
  assert.deepEqual(of("resolve").map((b: any) => b.id).sort(), ["T1", "T2", "T3", "T5"]);
});

test("publish keeps a superseded thread open when its restatement landed nowhere", async () => {
  const { gh } = fake({ "POST /repos/o/r/pulls/7/comments": () => ({ status: 422, data: {} }) }, [{ id: "T5", body: `${MARKER.finding}\nx` }]);
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

test("publish in shadow mode posts only the check run", async () => {
  const { gh, calls } = fake({});
  await publish(gh, { ...T, shadow: true }, { verdict: verdict({ inline_comments: [comment(), comment({ line: 9 })] }) });
  assert.deepEqual(calls.filter((c) => !c.key.startsWith("GET") && c.key !== "threads").map((c) => c.key), ["POST /repos/o/r/check-runs"]);
  assert.match(calls.find((c) => c.key === "POST /repos/o/r/check-runs")!.body.output.summary, /`a.go:2` — b panics/);
  await publish(gh, { ...T, shadow: true }, { failure: "pi exited with 1" });
  assert.equal(calls.filter((c) => c.key === "POST /repos/o/r/issues/7/comments").length, 0);
});
