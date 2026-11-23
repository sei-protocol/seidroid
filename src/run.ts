import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { followUpPrompt, reviewPrompt, type Request } from "./prompt.ts";
import { replyPrompt, type ReplyRequest } from "./reply.ts";
import { scoutPrompt, type ScoutRequest } from "./scout.ts";
import { scanSecrets } from "./secrets.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, "extension.ts");
const PI = path.join(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const SESSION_ID = "seidroid";
const OIDC_AUDIENCE = "https://api.anthropic.com";
const OPENAI_AUDIENCE = "https://api.openai.com/v1";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OIDC_REFRESH_MS = 4 * 60_000;
const OIDC_REQUEST_MS = 30_000;
/** Credentials the model's process never needs; the runner keeps them to itself. */
const WITHHELD_ENV = ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];

export type Role = "review" | "scout" | "reply";

export interface Stats {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  error: string;
  /** commands are the shell commands the model ran, in order, with whether each failed. */
  commands: { id: string; command: string; failed?: boolean }[];
  /** reads are the paths the model opened with the read tool, in order. */
  reads: { id: string; path: string }[];
}

export const emptyStats = (): Stats => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, error: "", commands: [], reads: [] });

const MAX_COMMANDS = 200;
const MAX_COMMAND_CHARS = 1000;

/** tally folds one JSONL event from pi into stats, counting each finished assistant message once and noting each shell command. */
export function tally(stats: Stats, record: string): void {
  let event: {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    args?: { command?: unknown; path?: unknown };
    isError?: boolean;
    durationMs?: number;
    message?: { role?: string; usage?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>> & { cost?: { total?: number } }; stopReason?: string; errorMessage?: string };
  };
  try {
    event = JSON.parse(record);
  } catch {
    return;
  }
  if (event.toolName === "bash" && event.type === "tool_execution_start" && stats.commands.length < MAX_COMMANDS) {
    stats.commands.push({ id: String(event.toolCallId), command: String(event.args?.command ?? "").slice(0, MAX_COMMAND_CHARS) });
  }
  if (event.toolName === "bash" && event.type === "tool_execution_end") {
    const i = stats.commands.findIndex((c) => c.id === String(event.toolCallId));
    // pi reports no duration for a call it refused before running it.
    if (i >= 0 && event.durationMs === undefined) stats.commands.splice(i, 1);
    else if (i >= 0) stats.commands[i]!.failed = event.isError === true;
  }
  if (event.toolName === "read" && event.type === "tool_execution_start" && stats.reads.length < MAX_COMMANDS) {
    stats.reads.push({ id: String(event.toolCallId), path: String(event.args?.path ?? "").slice(0, MAX_COMMAND_CHARS) });
  }
  if (event.toolName === "read" && event.type === "tool_execution_end" && event.isError === true) {
    const i = stats.reads.findIndex((r) => r.id === String(event.toolCallId));
    if (i >= 0) stats.reads.splice(i, 1);
  }
  const m = event.message;
  if (event.type !== "message_end" || m?.role !== "assistant") return;
  stats.turns++;
  stats.input += m.usage?.input ?? 0;
  stats.output += m.usage?.output ?? 0;
  stats.cacheRead += m.usage?.cacheRead ?? 0;
  stats.cacheWrite += m.usage?.cacheWrite ?? 0;
  stats.cost += m.usage?.cost?.total ?? 0;
  if (m.stopReason === "error" || m.stopReason === "aborted") stats.error = m.errorMessage || m.stopReason;
}

/** RECORD is the directory under a run's outDir holding what the job uploads: the request, the submission and, when kept, the transcript. */
const RECORD = "record";
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
/** Records whose content a later record holds whole: streaming deltas, partial tool output, and the turn and run summaries. */
const REPEATS = ["message_start", "message_update", "tool_execution_update", "turn_end", "agent_end"];

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** keep is text as the record holds it: as is, or a note naming the credential it carried, with the fields of note. */
const keep = (text: string, literals: readonly string[], note: object = {}): string => {
  const found = scanSecrets(text, literals);
  return found ? JSON.stringify({ ...note, withheld: found }) : text;
};

/** transcriptLine is how one pi record is kept in the transcript; undefined for a record that repeats what another holds. */
export function transcriptLine(record: string, literals: readonly string[]): string | undefined {
  if (record.trim() === "") return undefined;
  let type: unknown;
  try {
    type = JSON.parse(record)?.type;
  } catch {}
  if (typeof type === "string" && REPEATS.includes(type)) return undefined;
  return keep(record, literals, typeof type === "string" ? { type } : {});
}

/** transcriber appends each pi record to file as transcriptLine keeps it, up to MAX_TRANSCRIPT_BYTES; with no file it keeps nothing. */
export function transcriber(file: string | undefined, literals: readonly string[]): { write(record: string): void; close(): void } {
  if (file === undefined) return { write() {}, close() {} };
  const fd = openSync(file, "w");
  let written = 0;
  return {
    write(record) {
      const line = transcriptLine(record, literals);
      if (line === undefined || written > MAX_TRANSCRIPT_BYTES) return;
      written += Buffer.byteLength(line) + 1;
      writeSync(fd, written > MAX_TRANSCRIPT_BYTES ? `${JSON.stringify({ type: "truncated" })}\n` : `${line}\n`);
    },
    close: () => closeSync(fd),
  };
}

export const submitTool = (role: Role): string => ({ review: "submit_review", scout: "submit_findings", reply: "submit_reply" })[role];

/** piArgs is pi's command line: headless, read-only tools (and a sandboxed shell when asked) plus the submit tool, and nothing loaded from the checkout. */
export function piArgs(role: Role, model: string, thinking: string, sessionDir?: string, shell = false): string[] {
  return [
    "--mode", "json",
    "--no-context-files", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-themes",
    "--extension", EXTENSION,
    "--tools", `read,grep,find,ls,${shell ? "bash," : ""}${submitTool(role)}`,
    "--model", model,
    "--thinking", thinking,
    ...(sessionDir ? ["--session-dir", sessionDir, "--session-id", SESSION_ID] : ["--no-session"]),
  ];
}

/** hasSession reports whether sessionDir already holds a conversation to continue. */
export const hasSession = (sessionDir: string): boolean =>
  existsSync(sessionDir) && readdirSync(sessionDir, { recursive: true }).some((f) => String(f).endsWith(".jsonl"));

/** githubIdToken asks GitHub's OIDC endpoint for a token addressed to audience. */
async function githubIdToken(audience: string): Promise<string> {
  const res = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(OIDC_REQUEST_MS),
  });
  if (!res.ok) throw new Error(`the GitHub OIDC token request failed with ${res.status}`);
  return ((await res.json()) as { value: string }).value;
}

const canRequestIdToken = (): boolean => Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);

/** keepIdentityTokenFresh rewrites the Anthropic federation token file from GitHub's OIDC endpoint until stopped. */
async function keepIdentityTokenFresh(): Promise<() => void> {
  const file = process.env.ANTHROPIC_IDENTITY_TOKEN_FILE;
  if (!file || !canRequestIdToken() || !process.env.ANTHROPIC_FEDERATION_RULE_ID) return () => {};
  const write = async () => writeFileSync(file, await githubIdToken(OIDC_AUDIENCE), { mode: 0o600 });
  await write();
  const timer = setInterval(() => write().catch((e) => console.error(String(e))), OIDC_REFRESH_MS);
  return () => clearInterval(timer);
}

/** openAIAccessToken exchanges the job's GitHub OIDC token for a short-lived OpenAI access token, or returns undefined when OpenAI federation is not configured. */
export async function openAIAccessToken(tokenUrl = OPENAI_TOKEN_URL): Promise<string | undefined> {
  const provider = process.env.OPENAI_IDENTITY_PROVIDER_ID;
  const account = process.env.OPENAI_SERVICE_ACCOUNT_ID;
  if (!provider || !account || !canRequestIdToken()) return undefined;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: await githubIdToken(OPENAI_AUDIENCE),
      identity_provider_id: provider,
      service_account_id: account,
    }),
    signal: AbortSignal.timeout(OIDC_REQUEST_MS),
  });
  if (!res.ok) throw new Error(`the OpenAI token exchange failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function promptFor(role: Role, request: unknown, sessionDir?: string): string {
  if (role === "scout") return scoutPrompt(request as ScoutRequest);
  if (role === "reply") return replyPrompt(request as ReplyRequest);
  return sessionDir && hasSession(sessionDir) ? followUpPrompt(request as Request) : reviewPrompt(request as Request);
}

/** run drives one pi conversation and writes submission.json (if the model submitted), run.json and the record to outDir; the record holds the transcript only when transcript is set. */
export async function run(o: { role: Role; request: unknown; outDir: string; model: string; thinking: string; timeoutMs: number; sessionDir?: string; home?: string; transcript?: boolean }): Promise<void> {
  mkdirSync(o.outDir, { recursive: true });
  const submission = path.join(o.outDir, "submission.json");
  rmSync(submission, { force: true });
  const recordDir = path.join(o.outDir, RECORD);
  rmSync(recordDir, { recursive: true, force: true });
  mkdirSync(recordDir);
  const prompt = promptFor(o.role, o.request, o.sessionDir);
  const env: NodeJS.ProcessEnv = { ...process.env, SEIDROID_OUT: submission, SEIDROID_SUBMIT: o.role, ...(o.home ? { SEIDROID_HOME: o.home, TMPDIR: o.home } : {}) };
  for (const k of WITHHELD_ENV) delete env[k];
  const literals = () => [...WITHHELD_ENV, "OPENAI_API_KEY"].flatMap((k) => [process.env[k] ?? "", env[k] ?? ""]);
  writeFileSync(path.join(recordDir, "request.json"), keep(JSON.stringify(o.request), literals()));

  const started = Date.now();
  const stats = emptyStats();
  const record = (exitCode: number | null, submitted: boolean) =>
    writeFileSync(path.join(o.outDir, "run.json"), JSON.stringify({ role: o.role, model: o.model, submitted, exitCode, durationMs: Date.now() - started, promptSha256: sha256(prompt), ...stats }));

  let stopRefresh: () => void;
  try {
    if (o.model.startsWith("openai/")) {
      const token = await openAIAccessToken();
      if (token) env.OPENAI_API_KEY = token;
    }
    stopRefresh = await keepIdentityTokenFresh();
  } catch (e) {
    stats.error = `no model credential: ${e instanceof Error ? e.message : String(e)}`;
    return record(null, false);
  }
  const held = literals();
  const transcript = transcriber(o.transcript ? path.join(recordDir, "transcript.jsonl") : undefined, held);
  const child = spawn(process.execPath, [PI, ...piArgs(o.role, o.model, o.thinking, o.sessionDir, o.home !== undefined)], { env, stdio: ["pipe", "pipe", "inherit"] });
  const timer = setTimeout(() => {
    stats.error = `timed out after ${o.timeoutMs / 1000}s`;
    child.kill("SIGTERM");
  }, o.timeoutMs);
  let pending = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const records = (pending + chunk).split("\n");
    pending = records.pop() ?? "";
    for (const r of records) {
      tally(stats, r);
      transcript.write(r);
    }
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  stopRefresh();
  tally(stats, pending);
  transcript.write(pending);
  transcript.close();

  const submitted = existsSync(submission);
  if (submitted) writeFileSync(path.join(recordDir, "submission.json"), keep(readFileSync(submission, "utf8"), held));
  if (!submitted && stats.error === "") stats.error = code === 0 ? `the model ended without calling ${submitTool(o.role)}` : `pi exited with ${code}`;
  record(code, submitted);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      request: { type: "string" },
      out: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string", default: "high" },
      session: { type: "string" },
      timeout: { type: "string", default: "1500" },
    },
  });
  const role = positionals[0];
  const timeout = Number(values.timeout);
  if ((role !== "review" && role !== "scout") || !values.request || !values.out || !values.model || !(timeout > 0)) {
    throw new Error("usage: run.ts review|scout --request <file> --out <dir> --model <id> [--thinking <level>] [--session <dir>] [--timeout <seconds>]");
  }
  await run({
    role,
    request: JSON.parse(readFileSync(values.request, "utf8")),
    outDir: values.out,
    model: values.model,
    thinking: values.thinking,
    timeoutMs: timeout * 1000,
    sessionDir: values.session,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
