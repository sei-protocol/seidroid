// Offline follow-up review for the scout eval: lays a sei-chain head out like the review job,
// runs the scouts (whole diff, or since the session's last reading) and the review, and writes result.json.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { recordFindings, recordedThreads } from "../src/history.ts";
import * as job from "../src/job.ts";
const { changedLines, scout } = job;
import { DIFF, INTENT, STANDARDS, TREE, type Request } from "../src/prompt.ts";
import { run } from "../src/run.ts";
import { parseSubmission, reportedFindings, verdictOf } from "../src/verdict.ts";

const { values: o } = parseArgs({ options: { pr: { type: "string" }, head: { type: "string" }, main: { type: "string" }, src: { type: "string" }, work: { type: "string" }, session: { type: "string" }, threads: { type: "string" }, "scouts-session": { type: "string" } } });
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 1 << 30 });
const pr = Number(o.pr);
const sessionDir = path.resolve(o.session!);
const threads = (o.threads ?? "").split(",").filter((f) => f && existsSync(f)).flatMap((f) => JSON.parse(readFileSync(path.resolve(f), "utf8")));
const work = path.resolve(o.work!);
const tree = path.join(work, TREE);
mkdirSync(work, { recursive: true });
git(o.src!, "worktree", "add", "-q", "--detach", tree, o.head!);
const base = git(tree, "merge-base", o.main!, o.head!).trim();
const diff = git(tree, "diff", "--no-ext-diff", `${base}..${o.head}`);
writeFileSync(path.join(work, DIFF), diff);
let standards = "";
try { standards = git(tree, "show", `${o.main}:REVIEW.md`); } catch {}
if (standards) writeFileSync(path.join(work, STANDARDS), standards);
const pull = JSON.parse(execFileSync("gh", ["api", `repos/sei-protocol/sei-chain/pulls/${pr}`], { encoding: "utf8" }));
writeFileSync(path.join(work, INTENT), `# ${pull.title}\n\n${pull.body ?? ""}\n`);
const diffLines = changedLines(diff);
const home = path.join(work, "home");
mkdirSync(home);
const out = path.join(work, "out");
process.chdir(work);
const timeoutMs = 1800_000;

const t0 = Date.now();
const { readings, since } = await scout({ models: ["openai/gpt-6.1-sol"], request: { repo: "sei-protocol/sei-chain", pr, diffLines }, work, out, sessionDir: o["scouts-session"] === "true" ? sessionDir : undefined, base, head: o.head!, thinking: "high", timeoutMs, transcript: false });
const t1 = Date.now();
const request: Request = { repo: "sei-protocol/sei-chain", pr, diffLines, hasTree: true, hasStandards: standards !== "", hasShell: true, includeNits: false, scouts: readings, threads };
await run({ role: "review", request, outDir: path.join(out, "review"), model: "anthropic/claude-opus-5-5", thinking: "high", timeoutMs, sessionDir, home, transcript: false });
const t2 = Date.now();

const runOf = (d: string) => (existsSync(path.join(d, "run.json")) ? JSON.parse(readFileSync(path.join(d, "run.json"), "utf8")) : undefined);
const stats = (r: any) => r && { ms: r.durationMs, tokens: r.input + r.output + r.cacheRead + r.cacheWrite, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, cost: r.cost, error: r.error, commands: r.commands?.length ?? 0 };
const scoutRuns = existsSync(out) ? readdirSync(out).filter((d) => d.startsWith("scout-")).map((d) => runOf(path.join(out, d))) : [];
const sub = existsSync(path.join(out, "review", "submission.json")) ? JSON.parse(readFileSync(path.join(out, "review", "submission.json"), "utf8")) : undefined;
const raw = sub ? parseSubmission(sub) : undefined;
// The checked-callee rule, where this revision has it, runs on the submission as the job would publish it.
const confirm = (job as any).confirmCrossChecks;
const parsed = raw?.ok && typeof confirm === "function" ? { ok: true as const, submission: confirm(raw.submission, runOf(path.join(out, "review"))) } : raw;
const rawFindings = raw?.ok ? reportedFindings(verdictOf(raw.submission)) : [];
const findings = parsed?.ok ? reportedFindings(verdictOf(parsed.submission)) : [];
if (parsed?.ok) writeFileSync(path.join(work, "threads.json"), JSON.stringify(recordedThreads(recordFindings(pr, findings), pr) ?? []));
writeFileSync(path.join(work, "result.json"), JSON.stringify({
  pr, head: o.head, base, diffLines, since, sinceLines: existsSync(path.join(work, "since.diff")) ? changedLines(readFileSync(path.join(work, "since.diff"), "utf8")) : null,
  scoutWallMs: t1 - t0, reviewWallMs: t2 - t1,
  scouts: scoutRuns.map(stats), scoutFindings: readings.map((r) => ({ name: r.name, note: r.note, read: r.read, findings: r.findings })),
  review: stats(runOf(path.join(out, "review"))),
  decision: parsed?.ok ? parsed.submission.decision : `none: ${parsed && !parsed.ok ? parsed.reason : "no submission"}`,
  rawDecision: raw?.ok ? raw.submission.decision : undefined,
  rawFindings: rawFindings.map((f) => ({ severity: f.severity, file: f.file, line: f.line, detail: f.detail })),
  topBlockers: parsed?.ok ? parsed.submission.blockers ?? [] : [],
  checked: parsed?.ok ? (parsed.submission.inline_comments ?? []).map((c: any) => c.checked ?? null) : [],
  findings: findings.map((f) => ({ severity: f.severity, file: f.file, line: f.line, detail: f.detail })),
  summary: parsed?.ok ? parsed.submission.summary : "",
}, null, 2));
console.log(JSON.stringify({ decision: parsed?.ok ? parsed.submission.decision : "none", since, blockers: findings.filter((f) => f.severity === "blocker").map((f) => `${f.file}:${f.line}`) }));
