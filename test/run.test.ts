import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyStats, openAIAccessToken, piArgs, run, sha256, tally, transcriber, transcriptLine } from "../src/run.ts";
import { scoutPrompt } from "../src/scout.ts";

test("tally sums usage over finished assistant messages", () => {
  const s = emptyStats();
  const usage = { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, cost: { total: 0.5 } };
  tally(s, JSON.stringify({ type: "message_update", message: { role: "assistant", usage } }));
  tally(s, JSON.stringify({ type: "message_end", message: { role: "user" } }));
  tally(s, JSON.stringify({ type: "message_end", message: { role: "assistant", usage, stopReason: "toolUse" } }));
  tally(s, JSON.stringify({ type: "message_end", message: { role: "assistant", usage, stopReason: "error", errorMessage: "529" } }));
  tally(s, JSON.stringify({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "go test ./..." } }));
  tally(s, JSON.stringify({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "pr.diff" } }));
  tally(s, JSON.stringify({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: true, durationMs: 40 }));
  tally(s, JSON.stringify({ type: "tool_execution_start", toolCallId: "d", toolName: "bash", args: {} }));
  tally(s, JSON.stringify({ type: "tool_execution_end", toolCallId: "d", toolName: "bash", isError: true }));
  tally(s, JSON.stringify({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "ls" } }));
  tally(s, "not json");
  assert.deepEqual(s, {
    turns: 2, input: 20, output: 4, cacheRead: 10, cacheWrite: 2, cost: 1, error: "529",
    commands: [{ id: "a", command: "go test ./...", failed: true }, { id: "c", command: "ls" }],
  });
});

test("piArgs loads nothing from the checkout and offers only read tools", () => {
  const a = piArgs("review", "anthropic/claude-opus", "high", "/s");
  for (const flag of ["--no-context-files", "--no-approve", "--no-extensions", "--no-skills", "--no-mcp"]) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf("--tools") + 1], "read,grep,find,ls,submit_review");
  assert.deepEqual(a.slice(-4), ["--session-dir", "/s", "--session-id", "seidroid"]);
  assert.equal(piArgs("scout", "openai/gpt", "high").at(-1), "--no-session");
  const r = piArgs("reply", "anthropic/claude-opus", "high");
  assert.equal(r[r.indexOf("--tools") + 1], "read,grep,find,ls,submit_reply");
  const shell = piArgs("review", "anthropic/claude-opus", "high", undefined, true);
  assert.equal(shell[shell.indexOf("--tools") + 1], "read,grep,find,ls,bash,submit_review");
});

test("run records a failed credential request in run.json without starting pi", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "run-"));
  const saved = { ...process.env };
  Object.assign(process.env, {
    ANTHROPIC_FEDERATION_RULE_ID: "rule",
    ANTHROPIC_IDENTITY_TOKEN_FILE: path.join(dir, "token"),
    ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:1/token?x=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer-held-by-the-runner",
  });
  const request = { repo: "o/r", pr: 1, diffLines: 1 };
  const second = path.join(dir, "second");
  try {
    await run({ role: "scout", request, outDir: dir, model: "m", thinking: "high", timeoutMs: 1000 });
    await run({ role: "scout", request: { ...request, repo: "bearer-held-by-the-runner" }, outDir: second, model: "m", thinking: "high", timeoutMs: 1000 });
  } finally {
    process.env = saved;
  }
  const got = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
  assert.equal(got.submitted, false);
  assert.equal(got.exitCode, null);
  assert.match(got.error, /^no model credential/);
  assert.equal(got.promptSha256, sha256(scoutPrompt(request)));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "record", "request.json"), "utf8")), request);
  assert.deepEqual(JSON.parse(readFileSync(path.join(second, "record", "request.json"), "utf8")), { withheld: "a credential this process holds" });
});

test("transcriptLine keeps whole records, drops repeats and withholds credentials", () => {
  const end = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  assert.equal(transcriptLine(end, []), end);
  assert.equal(transcriptLine("not json", []), "not json");
  for (const type of ["message_start", "message_update", "tool_execution_update", "turn_end", "agent_end"]) assert.equal(transcriptLine(JSON.stringify({ type }), []), undefined, type);
  assert.equal(transcriptLine("", []), undefined);
  const leak = JSON.stringify({ type: "tool_execution_end", result: { content: [{ type: "text", text: "token-held-here" }] } });
  assert.equal(transcriptLine(leak, ["token-held-here"]), JSON.stringify({ type: "tool_execution_end", withheld: "a credential this process holds" }));
  assert.equal(transcriptLine("ghp_abcdefghijklmnopqrstuvwxyz0123", []), JSON.stringify({ withheld: "github token" }));
});

test("openAIAccessToken exchanges the job's OIDC token for an OpenAI access token", async () => {
  const seen: { url: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      seen.push({ url: req.url!, body });
      if (req.url!.startsWith("/oidc")) return res.end(JSON.stringify({ value: `jwt-for-${new URL(req.url!, "http://x").searchParams.get("audience")}` }));
      const ok = JSON.parse(body).service_account_id === "svc";
      res.writeHead(ok ? 200 : 401).end(ok ? JSON.stringify({ access_token: "short-lived" }) : '{"error":"invalid_grant"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const saved = { ...process.env };
  try {
    assert.equal(await openAIAccessToken(`${base}/token`), undefined);
    Object.assign(process.env, { ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer", OPENAI_IDENTITY_PROVIDER_ID: "idp", OPENAI_SERVICE_ACCOUNT_ID: "svc" });
    assert.equal(await openAIAccessToken(`${base}/token`), "short-lived");
    assert.deepEqual(JSON.parse(seen.at(-1)!.body), {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: "jwt-for-https://api.openai.com/v1",
      identity_provider_id: "idp",
      service_account_id: "svc",
    });
    process.env.OPENAI_SERVICE_ACCOUNT_ID = "other";
    await assert.rejects(openAIAccessToken(`${base}/token`), /OpenAI token exchange failed with 401: \{"error":"invalid_grant"\}/);
  } finally {
    process.env = saved;
    server.close();
  }
});

test("transcriber writes kept records to its file, and nothing without one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "transcript-"));
  const file = path.join(dir, "transcript.jsonl");
  const kept = transcriber(file, []);
  for (const r of ['{"type":"message_end"}', '{"type":"message_update"}', "", '{"type":"tool_execution_end"}']) kept.write(r);
  kept.close();
  assert.equal(readFileSync(file, "utf8"), '{"type":"message_end"}\n{"type":"tool_execution_end"}\n');

  const none = transcriber(undefined, []);
  none.write('{"type":"message_end"}');
  none.close();
  assert.deepEqual(readdirSync(dir), ["transcript.jsonl"]);
});
