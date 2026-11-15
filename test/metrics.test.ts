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

test("comparer counts v1 missing once it has waited long enough", async () => {
  const m = metrics();
  let reads = 0;
  const gh: GitHub = { rest: async (): Promise<any> => (reads++, { status: 200, data: { check_runs: [{ status: "in_progress", app: { slug: "seidroid" }, output: { title: null } }] } }), graphql: async (): Promise<any> => ({}) };
  const c = comparer(m, { check: "review", job: "j", waitMs: 1000 }, { github: async () => gh, bot: async () => "seidroid[bot]" });
  const shadowed = { owner: "o", repo: "r", head: "h", v2: { verdict: "pass", findings: 0, preExisting: 0 }, at: 0 };
  c.add(shadowed);
  c.add(shadowed);
  await c.tick(500);
  assert.equal(c.waiting, 1);
  await c.tick(2000);
  assert.equal(c.waiting, 0);
  assert.equal(reads, 2);
  assert.match(await m.registry.metrics(), /seidroid_comparisons_total\{repo="o\/r",v1="missing",v2="pass"\} 1\n/);
});
