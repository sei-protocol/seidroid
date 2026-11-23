import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { GitHub } from "../src/github.ts";
import { besides, changedLines, changesSince, confirmCrossChecks, conversation, earlierFindings, FULL_READ_ABOVE, guard, keepsTranscripts, lastScouted, loadSession, priorThreads, readsSince, recordInputs, requested, readAll, runsIn, saveSession, scout, scoutPlan, service, standingOf, type Event, type GuardOptions, type OwnReviews, type Standing } from "../src/job.ts";
import { MARKER } from "../src/render.ts";
import { sha256 } from "../src/run.ts";
import { guidelinesPath } from "../src/text.ts";

const opts: GuardOptions = { phrase: "@seidroid", skipLabel: "ai: skip-review", reReviewOnPush: false, allowedBots: ["renovate[bot]"], shadow: false };
const repository = { full_name: "o/r" };

function gh(pull: Record<string, unknown> = {}, reviews: { state: string; body: string; user: { type: string } }[] = []): GitHub {
  const data = { state: "open", draft: false, labels: [], head: { sha: "h", repo: { id: 1 } }, base: { repo: { id: 1 } }, user: { login: "bob" }, ...pull };
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

const push = (action: string, actor = "alice"): Event => ({ name: "pull_request", actor, payload: { action, repository, pull_request: { number: 7 } } });
const ask = (body: string, actor = "alice", type = "User"): Event => ({
  name: "issue_comment",
  actor,
  payload: { action: "created", repository, issue: { number: 7, pull_request: {} }, comment: { id: 5, body, user: { type } } },
});
const verdict = (state: string) => ({ state, body: `${MARKER.verdict}\nreviewed`, user: { type: "Bot" } });
const team = async () => ({ actor: true, author: true });
const unread: OwnReviews = async () => {
  throw new Error("only shadow reads its own check runs");
};
const ownChecks = (standing?: Standing): OwnReviews => async () => standing;
const outsider = async () => ({ actor: false, author: true });

test("guard admits what v1 admits and nothing more", async () => {
  const shadow = { ...opts, shadow: true };
  const cases: [string, Event, GitHub, GuardOptions, boolean, RegExp, OwnReviews?][] = [
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
    ["an outsider's push to a team member's pull request", push("synchronize", "mallory"), gh(), opts, false, /mallory is not on the team/],
    ["a team request", ask("@seidroid review"), gh({ draft: true }, [verdict("APPROVED")]), opts, true, /alice asked/],
    ["an outsider's request", ask("@seidroid review", "mallory"), gh(), opts, false, /mallory may not/],
    ["an allowed bot", ask("@seidroid review", "renovate[bot]", "Bot"), gh(), opts, true, /asked/],
    ["another bot", ask("@seidroid review", "spam[bot]", "Bot"), gh(), opts, false, /may not/],
    ["no mention", ask("thanks seidroid"), gh(), opts, false, /does not ask/],
    ["a request on a fork", ask("@seidroid review"), gh({ head: { sha: "h", repo: { id: 2 } } }), opts, false, /fork/],
    ["another event", { name: "pull_request_target", actor: "alice", payload: { repository } }, gh(), opts, false, /does not start/],
    ["v1's review in shadow", push("ready_for_review"), gh({}, [verdict("APPROVED")]), shadow, true, /no review yet/, ownChecks()],
    ["v1's change request in shadow", push("synchronize"), gh({}, [verdict("CHANGES_REQUESTED")]), shadow, false, /already reviewed/, ownChecks("reviewed")],
    ["its own review in shadow", push("reopened"), gh(), shadow, false, /already reviewed/, ownChecks("changes_requested")],
    ["its own change request in shadow", push("synchronize"), gh({}, [verdict("APPROVED")]), shadow, true, /lift/, ownChecks("changes_requested")],
  ];
  for (const [name, ev, client, o, run, reason, ownReviews = unread] of cases) {
    const gate = await guard(ev, o, client, ev.actor === "mallory" ? outsider : team, ownReviews);
    assert.equal(gate.run, run, name);
    assert.match(gate.reason, reason, name);
    assert.equal(gate.head, run ? "h" : "", name);
  }
  const outsiders = await guard(push("opened"), opts, gh(), async () => ({ actor: true, author: false }), unread);
  assert.equal(outsiders.run, false);
  assert.match(outsiders.reason, /bob is not on the team/);
  const asked = await guard(ask("@seidroid review\nRun go test ./x/"), opts, gh(), team, unread);
  assert.equal(asked.ask, "Run go test ./x/");
  assert.equal((await guard(ask("@seidroid review\nrun it", "renovate[bot]", "Bot"), opts, gh(), team, unread)).ask, "");
});

test("standingOf reads seidroid's latest review from the service's history and refuses a service too old to say", () => {
  assert.equal(standingOf({ conclusion: null }), undefined);
  assert.equal(standingOf({ conclusion: "failure" }), "changes_requested");
  for (const conclusion of ["success", "neutral"]) assert.equal(standingOf({ conclusion }), "reviewed");
  assert.throws(() => standingOf({}), /predates/);
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
    const gate = await guard(ev, o, client, async (_pr, comment) => (asked.push(comment), { actor: ev.actor !== "mallory", author: true }), unread);
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

test("earlierFindings reads the service's record in shadow, never the threads on the pull request", async (t) => {
  const asked: unknown[] = [];
  let status = 200;
  const recorded = [{ id: "", file: "a.go", line: 3, body: "**blocker** — panics", replies: [], resolved: false }];
  const srv = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      if (url.pathname === "/history") asked.push(JSON.parse(body));
      if (url.pathname === "/history") res.statusCode = status;
      res.setHeader("Content-Type", "application/json").end(url.pathname === "/token" ? '{"value":"t"}' : JSON.stringify({ threads: recorded }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  Object.assign(process.env, { ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer" });
  t.after(() => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  });
  let read = 0;
  const gh: GitHub = {
    async rest() {
      throw new Error("unused");
    },
    async graphql(): Promise<any> {
      read++;
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
    },
  };
  assert.deepEqual(await earlierFindings(gh, origin, "o", "r", 7, true), recorded);
  assert.deepEqual(asked, [{ pr: 7 }]);
  status = 500;
  assert.deepEqual(await earlierFindings(gh, origin, "o", "r", 7, true), []);
  assert.equal(read, 0);
  assert.deepEqual(await earlierFindings(gh, origin, "o", "r", 7, false), []);
  assert.equal(read, 1);
});

test("runsIn reports each run under out with its commands counted", () => {
  const out = mkdtempSync(path.join(tmpdir(), "runs-"));
  for (const [dir, run] of [["scout-0", { role: "scout", commands: [] }], ["review", { role: "review", commands: [{ id: "1", command: "go test", failed: true }, { id: "2", command: "ls" }], reads: [{ id: "3", path: "tree/a.go" }] }]] as const) {
    mkdirSync(path.join(out, dir));
    writeFileSync(path.join(out, dir, "run.json"), JSON.stringify(run));
  }
  mkdirSync(path.join(out, "empty"));
  assert.deepEqual(runsIn(out).sort((a: any, b: any) => a.role.localeCompare(b.role)), [{ role: "review", commands: 2, failedCommands: 1 }, { role: "scout", commands: 0, failedCommands: 0 }]);
});

test("recordInputs hashes the files laid out for the model, with the commits they come from", () => {
  const work = mkdtempSync(path.join(tmpdir(), "work-"));
  writeFileSync(path.join(work, "pr.diff"), "diff --git a/x b/x\n");
  writeFileSync(path.join(work, "intent.md"), "# Title\n");
  const out = path.join(work, "out");
  recordInputs(out, work, { base: { sha: "b" }, head: { sha: "h" } });
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, "inputs.json"), "utf8")), {
    base: "b",
    head: "h",
    sha256: { "pr.diff": sha256("diff --git a/x b/x\n"), "intent.md": sha256("# Title\n") },
  });
});

test("keepsTranscripts only for a repository known to be private", () => {
  assert.equal(keepsTranscripts({ private: "true" }), true);
  for (const visibility of ["false", "", "True", "null"]) assert.equal(keepsTranscripts({ private: visibility }), false);
  assert.equal(keepsTranscripts({}), false);
});

function history() {
  const tree = mkdtempSync(path.join(tmpdir(), "since-"));
  const g = (...args: string[]) => execFileSync("git", ["-C", tree, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  const commit = (file: string, text: string) => {
    writeFileSync(path.join(tree, file), text);
    g("add", "-A");
    g("commit", "-qm", file);
    return g("rev-parse", "HEAD");
  };
  g("init", "-q", "-b", "main");
  const base = commit("a", "1\n");
  const read = commit("pr", "first\n");
  g("checkout", "-q", "-b", "upstream", base);
  const moved = commit("b", "upstream\n");
  g("checkout", "-q", "--detach", read);
  g("merge", "-q", "--no-edit", moved);
  const head = commit("pr", "first\nsecond\n");
  return { tree, base, read, moved, head };
}

test("changesSince leaves out what the base brought in, and is undefined for a head it cannot reach", () => {
  const h = history();
  const last = { head: h.read, base: h.base, readings: {} };
  const diff = changesSince(h.tree, last, h.moved, h.head)!;
  assert.match(diff, /^\+second$/m);
  assert.doesNotMatch(diff, /upstream/);
  assert.equal(changedLines(diff), 1);
  assert.equal(changesSince(h.tree, { ...last, head: "f".repeat(40) }, h.moved, h.head), undefined);
});

test("lastScouted needs a restored session and a well-formed record", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "session-"));
  const record = { head: "a".repeat(40), base: "b".repeat(40), readings: { m: { read: 3, inert: false, findings: [] } } };
  writeFileSync(path.join(dir, "scouts.json"), JSON.stringify(record));
  assert.equal(lastScouted(dir), undefined, "no conversation to continue");
  writeFileSync(path.join(dir, "s.jsonl"), "{}\n");
  assert.deepEqual(lastScouted(dir), record);
  for (const bad of [{ ...record, head: "--output=x" }, { ...record, readings: { m: { read: 3 } } }]) {
    writeFileSync(path.join(dir, "scouts.json"), JSON.stringify(bad));
    assert.equal(lastScouted(dir), undefined);
  }
  assert.equal(lastScouted(undefined), undefined);
});

test("scout keeps a reading when nothing changed since it, and records the new head", async () => {
  const h = history();
  const work = mkdtempSync(path.join(tmpdir(), "work-"));
  execFileSync("git", ["clone", "-q", h.tree, path.join(work, "tree")]);
  const sessionDir = path.join(work, "session");
  mkdirSync(sessionDir);
  writeFileSync(path.join(sessionDir, "s.jsonl"), "{}\n");
  const reading = { read: 2, inert: false, findings: [{ file: "pr", line: 1, severity: "high" as const, detail: "wrong" }] };
  writeFileSync(path.join(sessionDir, "scouts.json"), JSON.stringify({ head: h.head, base: h.moved, readings: { "openai/m": reading, n: reading } }));
  const got = await scout({ models: ["openai/m", "n"], request: { repo: "o/r", pr: 7, diffLines: 2 }, work, out: path.join(work, "out"), sessionDir, base: h.moved, head: h.head, thinking: "high", timeoutMs: 1, transcript: false });
  assert.equal(got.since, true);
  assert.deepEqual(got.readings, [{ name: "cross-check A", note: "", ...reading }, { name: "cross-check B", note: "", ...reading }]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(sessionDir, "scouts.json"), "utf8")), { head: h.head, base: h.moved, readings: { "openai/m": reading, n: reading } });
});

test("readsSince only for a change that is small next to a diff of at most FULL_READ_ABOVE lines", () => {
  assert.equal(FULL_READ_ABOVE, 500);
  for (const [changed, diffLines, want] of [[0, 1, true], [25, 100, true], [26, 100, false], [125, 500, true], [126, 500, false], [1, 501, false], [0, 4000, false], [1089, 2495, false]] as const) {
    assert.equal(readsSince(changed, diffLines), want, `${changed} of ${diffLines}`);
  }
});

test("scoutPlan builds on a reading only on the same base", () => {
  const rename = "diff --git a/x b/y\nold mode 100644\nnew mode 100755\nsimilarity index 100%\nrename from x\nrename to y\n";
  const edit = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
  for (const [diff, sameBase, want] of [[undefined, true, "whole"], ["", true, "keep"], ["", false, "whole"], [rename, true, "since"], [edit, true, "since"], [edit, false, "whole"], [edit.repeat(30), true, "whole"]] as const) {
    assert.equal(scoutPlan(diff, sameBase, 10), want, `${JSON.stringify(diff)?.slice(0, 20)} sameBase=${sameBase}`);
  }
  assert.equal(scoutPlan("", true, FULL_READ_ABOVE + 1), "keep");
  assert.equal(scoutPlan(edit, true, FULL_READ_ABOVE + 1), "whole");
});

test("readAll keeps only readings of everything the scout was asked to read", () => {
  const got = (read: number) => ({ read, inert: false, findings: [] });
  for (const [g, asked, want] of [[got(100), 100, true], [got(120), 100, true], [got(99), 100, false], [got(0), 0, false], [got(3), 0, true], ["it timed out", 0, false]] as const) {
    assert.equal(readAll(g, asked), want, `${JSON.stringify(g)} of ${asked}`);
  }
});

test("loadSession restores the kept session, and starts cold without one unless the service refuses the run", async (t) => {
  let status = 200;
  let packed = Buffer.alloc(0);
  const asked: string[] = [];
  const srv = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c)).on("end", () => {
      if (url.pathname === "/token") return res.setHeader("Content-Type", "application/json").end('{"value":"t"}');
      asked.push(`${req.method} ${url.search}`);
      if (req.method === "PUT") packed = Buffer.concat(chunks);
      res.statusCode = status;
      if (status === 200 && req.method === "GET") return res.setHeader("Content-Type", "application/zstd").end(packed);
      res.setHeader("Content-Type", "application/json").end(JSON.stringify({ error: `answered ${status}` }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  Object.assign(process.env, { ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer" });
  t.after(() => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  });
  const of = { pr: 7, comment: 5, shadow: false };
  const kept = mkdtempSync(path.join(tmpdir(), "seidroid-kept-"));
  writeFileSync(path.join(kept, "a_seidroid.jsonl"), "{}\n");
  await saveSession(origin, of, kept);
  assert.deepEqual(asked, ["PUT ?pr=7&comment=5&shadow=false"]);
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "seidroid-load-")), "session");
  assert.equal(await loadSession(origin, of, dir), "restored");
  assert.deepEqual(readdirSync(dir), ["a_seidroid.jsonl"]);

  packed = Buffer.from("not a session");
  assert.equal(await loadSession(origin, of, dir), "unavailable");
  assert.deepEqual(readdirSync(dir), []);
  for (const [code, want] of [[404, "none"], [501, "off"], [500, "unavailable"], [502, "unavailable"]] as const) {
    status = code;
    assert.equal(await loadSession(origin, of, dir), want);
    assert.deepEqual(readdirSync(dir), []);
  }
  assert.equal(await loadSession("http://127.0.0.1:1", of, dir), "unavailable");
  status = 403;
  await assert.rejects(loadSession(origin, of, dir), /answered 403/);
  await saveSession(origin, of, kept);
  status = 500;
  await saveSession(origin, of, kept);
});

test("confirmCrossChecks keeps a cross-check's blocker only when it names files the review opened in the tree", () => {
  const tree = mkdtempSync(path.join(tmpdir(), "tree-"));
  mkdirSync(path.join(tree, "db/mvcc"), { recursive: true });
  for (const f of ["db/mvcc/key.go", "db/mvcc/scan.go", "db/mvcc/merge.go"]) writeFileSync(path.join(tree, f), "package mvcc\n");
  const ran = {
    commands: [{ id: "1", command: "sed -n '1,80p' tree/db/mvcc/key.go" }, { id: "2", command: "cd tree/db/mvcc && grep -n Next scan.go", failed: true }, { id: "4", command: "grep -rn Split tree/db/mvcc" }],
    reads: [{ id: "3", path: "/w/tree/db/mvcc/merge.go" }],
  };
  const blocker = (body: string, checked?: string[]) => ({ path: "db/mvcc/store.go", line: 9, severity: "blocker" as const, body, ...(checked && { checked }) });
  const s = {
    read: 40, decision: "request_changes" as const, summary: "s",
    inline_comments: [
      blocker("Aliases the key, as the cross-check says.", ["db/mvcc/key.go", "./tree/db/mvcc/scan.go"]),
      blocker("Cross-check A: merges stale versions.", ["db/mvcc/merge.go"]),
      blocker("The cross-check says this leaks."),
      blocker("Cross-check B: the iterator outlives the batch.", ["db/mvcc/key.go", "db/mvcc/batch.go"]),
      blocker("The cross-check says this races.", ["db/mvcc/merge.go/../key.go"]),
      blocker("The cross-check says this copies.", ["db/mvcc"]),
      blocker("Drops the error."),
    ],
    blockers: ["Both cross-checks: no migration.", "Breaks the wire format."],
  };
  const got = confirmCrossChecks(s, ran, tree);
  assert.deepEqual(got.inline_comments!.map((c) => c.severity), ["blocker", "blocker", "suggestion", "suggestion", "suggestion", "suggestion", "blocker"]);
  assert.match(got.inline_comments![2]!.body, /^The cross-check says this leaks\.\n\nPosted as a suggestion: /);
  assert.deepEqual(got.blockers, ["Breaks the wire format."]);
  assert.deepEqual(got.non_blockers!.map((b) => b.split("\n\n")[0]), ["Both cross-checks: no migration."]);
  assert.equal(got.decision, "request_changes");
  const own = { ...s, inline_comments: [s.inline_comments[6]!], blockers: ["Breaks the wire format."] };
  assert.equal(confirmCrossChecks(own, ran, tree), own);
  assert.equal(confirmCrossChecks(s, ran, undefined), s);
  assert.equal(confirmCrossChecks({ ...s, inline_comments: [s.inline_comments[2]!], blockers: [] }, ran, tree).decision, "comment");
});
