import { test } from "node:test";
import assert from "node:assert/strict";
import { comparer } from "../src/compare.ts";
import type { GitHub } from "../src/github.ts";
import { failureReason, metrics, runResult, runStats, verdicts } from "../src/metrics.ts";

test("verdicts reads v1's and v2's check runs the same way", () => {
  const cases: [string, string, ReturnType<typeof verdicts>][] = [
    ["success", "0 findings", { verdict: "pass", findings: 0, preExisting: 0 }],
    ["success", "1 finding", { verdict: "pass", findings: 1, preExisting: 0 }],
    ["failure", "3 findings, 2 pre-existing", { verdict: "block", findings: 3, preExisting: 2 }],
    ["neutral", "0 findings", { verdict: "neutral", findings: 0, preExisting: 0 }],
    ["failure", "No verdict", { verdict: "no_verdict", findings: 0, preExisting: 0 }],
    ["failure", "review did not complete", { verdict: "no_verdict", findings: 0, preExisting: 0 }],
    ["failure", "review produced but not published", { verdict: "no_verdict", findings: 0, preExisting: 0 }],
  ];
  for (const [conclusion, title, want] of cases) assert.deepEqual(verdicts({ conclusion, title }), want, title);
});

test("runStats keeps only well-formed runs, within bounds", () => {
  assert.deepEqual(runStats("x"), []);
  const [r, ...rest] = runStats([{ role: "review", model: "a b", turns: 2.5, cost: -1, input: Infinity, durationMs: "9" }, { role: "admin" }, null]);
  assert.equal(rest.length, 0);
  assert.deepEqual(r, { role: "review", model: "other", submitted: false, error: "", durationMs: 0, turns: 2, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, commands: 0, failedCommands: 0 });
  assert.equal(runStats(Array(40).fill({ role: "scout" })).length, 16);
});

test("runResult and failureReason name how a run and a review ended", () => {
  assert.deepEqual(
    ["", "timed out after 1200s", "no model credential: x", "the model ended without calling submit_review", "pi exited with 1", "rate limited"].map((error) => runResult({ submitted: false, error })),
    ["error", "timeout", "credential", "no_submit", "exit", "error"],
  );
  assert.equal(runResult({ submitted: true, error: "aborted" }), "submitted");
  assert.deepEqual(
    ["the review did not finish: timed out after 1200s", "the review did not finish: pi exited with 1", "the review's submission broke the contract: x", "the review's answer carried a credential, so it was withheld", "the run gave no reason"].map(failureReason),
    ["timeout", "unfinished", "contract", "credential", "other"],
  );
});

interface Run {
  id: number;
  name: string;
  head: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  external_id?: string;
  app: { slug: string };
  output: { title: string | null };
}

/** checks fakes the GitHub check runs of o/r, which the comparer reads and settles, and its pull requests' commits. */
function checks(runs: Run[], pulls: Record<number, { updated: number; commits: string[] }> = {}, repo = "r") {
  const reads: string[] = [];
  const gh: GitHub = {
    rest: async (method, path, body: any): Promise<any> => {
      reads.push(`${method} ${path}`);
      const patch = new RegExp(`^/repos/o/${repo}/check-runs/(\\d+)$`).exec(path);
      if (method === "PATCH" && patch) {
        runs.find((r) => r.id === Number(patch[1]))!.external_id = body.external_id;
        return { status: 200, data: {} };
      }
      const listed = new RegExp(`^/repos/o/${repo}/commits/([\\w-]+)/check-runs\\?check_name=([^&]+)&filter=all&per_page=100$`).exec(path);
      if (method === "GET" && listed) return { status: 200, data: { check_runs: runs.filter((r) => r.head === listed[1] && r.name === decodeURIComponent(listed[2]!)).map((r) => ({ ...r })) } };
      if (method === "GET" && path === `/repos/o/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`) return { status: 200, data: Object.entries(pulls).map(([n, p]) => ({ number: Number(n), updated_at: at(p.updated), head: { sha: p.commits.at(-1) } })) };
      const commits = new RegExp(`^/repos/o/${repo}/pulls/(\\d+)/commits\\?per_page=100&page=(\\d+)$`).exec(path);
      const page = Number(commits?.[2]);
      if (method === "GET" && commits) return { status: 200, data: pulls[Number(commits[1])]!.commits.slice((page - 1) * 100, page * 100).map((sha) => ({ sha })) };
      return { status: 404, data: {} };
    },
    graphql: async (): Promise<any> => ({}),
  };
  return { gh, reads };
}

const at = (s: number) => new Date(s * 1000).toISOString();
const v2 = (id: number, head: string, done: number, externalId: string, title = "0 findings"): Run => ({ id, name: "Seidroid Review", head, status: "completed", conclusion: "success", started_at: at(done), completed_at: at(done), external_id: externalId, app: { slug: "seidroid" }, output: { title } });
const v1 = (id: number, head: string, done: number, conclusion = "failure", title = "2 findings"): Run => ({ id, name: "review", head, status: "completed", conclusion, started_at: at(done), completed_at: at(done), app: { slug: "seidroid" }, output: { title } });
const cfg = { check: "review", job: "j", waitMs: 1000_000, checkName: "Seidroid Review" };

test("comparer pairs each v2 review on a commit with one of v1's in order of completion, and keeps the pairing in the check runs", async () => {
  const m = metrics();
  const runs = [v2(1, "h", 10, "compare:pending:60"), v2(2, "h", 20, "compare:pending"), v2(3, "h", 5, "compare:v1:9"), v1(9, "h", 4), v1(10, "h", 15, "success", "0 findings"), { ...v1(11, "h", 1), app: { slug: "other" } }];
  const { gh } = checks(runs);
  const c = comparer(m, cfg, { github: async () => gh, bot: async () => "seidroid[bot]" });
  c.add("o", "r", "h");
  c.add("o", "r", "h");
  await c.tick(30_000);
  assert.equal(c.waiting, 1);
  runs.push(v1(12, "h", 25));
  await c.tick(40_000);
  assert.equal(c.waiting, 0);
  assert.deepEqual(runs.slice(0, 3).map((r) => r.external_id), ["compare:v1:10", "compare:v1:12", "compare:v1:9"]);
  const text = await m.registry.metrics();
  assert.match(text, /seidroid_comparisons_total\{repo="o\/r",v1="pass",v2="pass"\} 1\n/);
  assert.match(text, /seidroid_comparisons_total\{repo="o\/r",v1="block",v2="pass"\} 1\n/);
  assert.match(text, /seidroid_compared_first_total\{repo="o\/r",reviewer="v2"\} 2\n/);
});

test("comparer waits for v1's job to end, and counts v1 missing once it has waited long enough", async () => {
  const m = metrics();
  const job: Run = { ...v1(20, "h", 0), name: "j", status: "in_progress", started_at: at(0), completed_at: null, app: { slug: "github-actions" } };
  const runs = [v2(1, "h", 1, "compare:pending:60"), v1(9, "h", 1, "success", "0 findings"), job, v2(2, "h", 2, "compare:pending")];
  const { gh, reads } = checks(runs);
  let bot = async (): Promise<string> => Promise.reject(new Error("GitHub is down"));
  const c = comparer(m, { ...cfg, waitMs: 1000 }, { github: async () => gh, bot: () => bot() });
  c.add("o", "r", "h");
  await c.tick(10);
  bot = async () => "seidroid[bot]";
  await c.tick(1500);
  assert.equal(c.waiting, 1);
  Object.assign(job, { status: "completed", completed_at: at(300) });
  await c.tick(2500);
  assert.equal(c.waiting, 1);
  await c.tick(3500);
  assert.equal(c.waiting, 0);
  assert.deepEqual(runs.map((r) => r.external_id), ["compare:v1:9", undefined, undefined, "compare:missing"]);
  const text = await m.registry.metrics();
  assert.match(text, /seidroid_compared_duration_seconds_sum\{repo="o\/r",reviewer="v1"\} 300\n/);
  assert.match(text, /seidroid_compared_duration_seconds_sum\{repo="o\/r",reviewer="v2"\} 60\n/);
  assert.match(text, /seidroid_comparisons_total\{repo="o\/r",v1="missing",v2="pass"\} 1\n/);
  assert.match(text, /seidroid_compared_findings_count\{repo="o\/r",reviewer="v2"\} 1\n/);
  assert.equal(reads.filter((r) => r.startsWith("PATCH")).length, 2);
});

test("comparer waits for the job of v1's repeat review, not an earlier one, before it counts v1's time", async () => {
  const m = metrics();
  const done: Run = { ...v1(20, "h", 0), name: "j", started_at: at(0), completed_at: at(300), app: { slug: "github-actions" } };
  const running: Run = { ...done, id: 21, status: "in_progress", started_at: at(400), completed_at: null };
  const runs = [v2(1, "h", 300, "compare:v1:9"), v1(9, "h", 200), running, done, v2(2, "h", 700, "compare:pending:60"), v1(10, "h", 600)];
  const { gh } = checks(runs);
  const c = comparer(m, { ...cfg, waitMs: 1000_000 }, { github: async () => gh, bot: async () => "seidroid[bot]" });
  c.add("o", "r", "h");
  await c.tick(800_000);
  assert.equal(c.waiting, 1);
  Object.assign(running, { status: "completed", completed_at: at(900) });
  await c.tick(950_000);
  assert.equal(runs[4]!.external_id, "compare:v1:10");
  assert.match(await m.registry.metrics(), /seidroid_compared_duration_seconds_sum\{repo="o\/r",reviewer="v1"\} 500\n/);
});

test("comparer leaves a v1 review further than the wait from a v2 review unpaired, so later pairs do not shift", async () => {
  const m = metrics();
  const runs = [v1(9, "h", 1), v2(1, "h", 5000, "compare:pending"), v1(10, "h", 5001, "success", "0 findings")];
  const { gh } = checks(runs);
  const c = comparer(m, cfg, { github: async () => gh, bot: async () => "seidroid[bot]" });
  c.add("o", "r", "h");
  await c.tick(5_002_000);
  assert.equal(runs[1]!.external_id, "compare:v1:10");
});

test("comparer resumes after a restart from the recently updated pull requests of every repository, counting only reviews still pending", async () => {
  const m = metrics();
  const runs = [v2(1, "h", 1, "compare:pending"), v2(2, "g", 1, "compare:v1:9"), v1(9, "g", 1), v1(10, "h", 2), v2(3, "f", 1, "compare:pending"), v1(11, "f", 2), v2(4, "e", 1, "compare:pending"), v1(12, "e", 2)];
  const long = [...Array.from({ length: 120 }, (_, i) => `x${i}`), "e", "z"];
  const { gh, reads } = checks(runs, { 7: { updated: 1000, commits: ["a", "b", "c", "d", "g", "h"] }, 8: { updated: 999, commits: ["f"] }, 9: { updated: 1000, commits: long } });
  let repos = async (): Promise<{ owner: string; repo: string }[]> => Promise.reject(new Error("GitHub is down"));
  const c = comparer(m, cfg, { github: async () => gh, bot: async () => "seidroid[bot]", repos: () => repos() });
  await c.tick(3000_000);
  repos = async () => [{ owner: "o", repo: "r" }];
  await c.tick(3000_000);
  await c.tick(5000);
  assert.ok(!reads.some((r) => r.includes("/pulls/8/") || r.includes("/commits/a/")));
  assert.equal(reads.filter((r) => r.startsWith("GET /repos/o/r/pulls?")).length, 1);
  assert.equal(c.waiting, 0);
  assert.deepEqual([runs[0]!.external_id, runs[6]!.external_id], ["compare:v1:10", "compare:v1:12"]);
  const text = await m.registry.metrics();
  assert.match(text, /seidroid_comparisons_total\{repo="o\/r",v1="block",v2="pass"\} 2\n/);
});

test("comparer resumes a pending review however many other commits the rebuild finds", async () => {
  const m = metrics();
  const fakes = ["r0", "r1", "r2"].map((repo) => {
    const pulls = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [n, { updated: 1000, commits: Array.from({ length: 6 }, (_, k) => `${repo}-${n}-${k}`) }]));
    return checks(repo === "r0" ? [v2(1, "r0-0-5", 1, "compare:pending"), v1(9, "r0-0-5", 2)] : [], pulls, repo);
  });
  const c = comparer(m, cfg, { github: async (_, repo) => fakes[Number(repo.slice(1))]!.gh, bot: async () => "seidroid[bot]", repos: async () => ["r0", "r1", "r2"].map((repo) => ({ owner: "o", repo })) });
  await c.tick(3000_000);
  assert.equal(c.waiting, 0);
  assert.match(await m.registry.metrics(), /seidroid_comparisons_total\{repo="o\/r0",v1="block",v2="pass"\} 1\n/);
});
