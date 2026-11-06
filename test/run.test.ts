import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyStats, piArgs, run, tally } from "../src/run.ts";

test("tally sums usage over finished assistant messages", () => {
  const s = emptyStats();
  const usage = { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, cost: { total: 0.5 } };
  tally(s, JSON.stringify({ type: "message_update", message: { role: "assistant", usage } }));
  tally(s, JSON.stringify({ type: "message_end", message: { role: "user" } }));
  tally(s, JSON.stringify({ type: "message_end", message: { role: "assistant", usage, stopReason: "toolUse" } }));
  tally(s, JSON.stringify({ type: "message_end", message: { role: "assistant", usage, stopReason: "error", errorMessage: "529" } }));
  tally(s, "not json");
  assert.deepEqual(s, { turns: 2, input: 20, output: 4, cacheRead: 10, cacheWrite: 2, cost: 1, error: "529" });
});

test("piArgs loads nothing from the checkout and offers only read tools", () => {
  const a = piArgs("review", "anthropic/claude-opus", "high", "/s");
  for (const flag of ["--no-context-files", "--no-approve", "--no-extensions", "--no-skills", "--no-mcp"]) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf("--tools") + 1], "read,grep,find,ls,submit_review");
  assert.deepEqual(a.slice(-4), ["--session-dir", "/s", "--session-id", "seidroid"]);
  assert.equal(piArgs("scout", "openai/gpt", "high").at(-1), "--no-session");
});

test("run records a failed credential request in run.json without starting pi", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "run-"));
  const saved = { ...process.env };
  Object.assign(process.env, {
    ANTHROPIC_FEDERATION_RULE_ID: "rule",
    ANTHROPIC_IDENTITY_TOKEN_FILE: path.join(dir, "token"),
    ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:1/token?x=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer",
  });
  try {
    await run({ role: "scout", request: { repo: "o/r", pr: 1, diffLines: 1 }, outDir: dir, model: "m", thinking: "high", timeoutMs: 1000 });
  } finally {
    process.env = saved;
  }
  const got = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
  assert.equal(got.submitted, false);
  assert.equal(got.exitCode, null);
  assert.match(got.error, /^no model credential/);
});
