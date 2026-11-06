import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { followUpPrompt, reviewPrompt, type Request } from "./prompt.ts";
import { scoutPrompt, type ScoutRequest } from "./scout.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, "extension.ts");
const PI = path.join(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const SESSION_ID = "seidroid";
const OIDC_AUDIENCE = "https://api.anthropic.com";
const OIDC_REFRESH_MS = 4 * 60_000;
const OIDC_REQUEST_MS = 30_000;
/** Credentials the model's process never needs; the runner keeps them to itself. */
const WITHHELD_ENV = ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];

export type Role = "review" | "scout";

export interface Stats {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  error: string;
}

export const emptyStats = (): Stats => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, error: "" });

/** tally folds one JSONL event from pi into stats, counting each finished assistant message once. */
export function tally(stats: Stats, record: string): void {
  let event: { type?: string; message?: { role?: string; usage?: Partial<Record<keyof Stats, number>> & { cost?: { total?: number } }; stopReason?: string; errorMessage?: string } };
  try {
    event = JSON.parse(record);
  } catch {
    return;
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

export const submitTool = (role: Role): string => (role === "review" ? "submit_review" : "submit_findings");

/** piArgs is pi's command line: headless, read-only tools plus the submit tool, and nothing loaded from the checkout. */
export function piArgs(role: Role, model: string, thinking: string, sessionDir?: string): string[] {
  return [
    "--mode", "json",
    "--no-context-files", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-themes",
    "--extension", EXTENSION,
    "--tools", `read,grep,find,ls,${submitTool(role)}`,
    "--model", model,
    "--thinking", thinking,
    ...(sessionDir ? ["--session-dir", sessionDir, "--session-id", SESSION_ID] : ["--no-session"]),
  ];
}

/** hasSession reports whether sessionDir already holds a conversation to continue. */
export const hasSession = (sessionDir: string): boolean =>
  existsSync(sessionDir) && readdirSync(sessionDir, { recursive: true }).some((f) => String(f).endsWith(".jsonl"));

/** keepIdentityTokenFresh rewrites the Anthropic federation token file from GitHub's OIDC endpoint until stopped. */
async function keepIdentityTokenFresh(): Promise<() => void> {
  const file = process.env.ANTHROPIC_IDENTITY_TOKEN_FILE;
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!file || !url || !bearer || !process.env.ANTHROPIC_FEDERATION_RULE_ID) return () => {};
  const write = async () => {
    const res = await fetch(`${url}&audience=${encodeURIComponent(OIDC_AUDIENCE)}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(OIDC_REQUEST_MS),
    });
    if (!res.ok) throw new Error(`the GitHub OIDC token request failed with ${res.status}`);
    const { value } = (await res.json()) as { value: string };
    writeFileSync(file, value, { mode: 0o600 });
  };
  await write();
  const timer = setInterval(() => write().catch((e) => console.error(String(e))), OIDC_REFRESH_MS);
  return () => clearInterval(timer);
}

function promptFor(role: Role, request: unknown, sessionDir?: string): string {
  if (role === "scout") return scoutPrompt(request as ScoutRequest);
  return sessionDir && hasSession(sessionDir) ? followUpPrompt(request as Request) : reviewPrompt(request as Request);
}

/** run drives one pi conversation and writes submission.json (if the model submitted) and run.json to outDir. */
export async function run(o: { role: Role; request: unknown; outDir: string; model: string; thinking: string; timeoutMs: number; sessionDir?: string }): Promise<void> {
  mkdirSync(o.outDir, { recursive: true });
  const submission = path.join(o.outDir, "submission.json");
  rmSync(submission, { force: true });
  const prompt = promptFor(o.role, o.request, o.sessionDir);
  const env: NodeJS.ProcessEnv = { ...process.env, SEIDROID_OUT: submission, SEIDROID_SUBMIT: o.role };
  for (const k of WITHHELD_ENV) delete env[k];

  const started = Date.now();
  const stats = emptyStats();
  const record = (exitCode: number | null, submitted: boolean) =>
    writeFileSync(path.join(o.outDir, "run.json"), JSON.stringify({ role: o.role, model: o.model, submitted, exitCode, durationMs: Date.now() - started, ...stats }));

  let stopRefresh: () => void;
  try {
    stopRefresh = await keepIdentityTokenFresh();
  } catch (e) {
    stats.error = `no model credential: ${e instanceof Error ? e.message : String(e)}`;
    return record(null, false);
  }
  const child = spawn(process.execPath, [PI, ...piArgs(o.role, o.model, o.thinking, o.sessionDir)], { env, stdio: ["pipe", "pipe", "inherit"] });
  const timer = setTimeout(() => {
    stats.error = `timed out after ${o.timeoutMs / 1000}s`;
    child.kill("SIGTERM");
  }, o.timeoutMs);
  let pending = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const records = (pending + chunk).split("\n");
    pending = records.pop() ?? "";
    for (const r of records) tally(stats, r);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  stopRefresh();
  tally(stats, pending);

  const submitted = existsSync(submission);
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
