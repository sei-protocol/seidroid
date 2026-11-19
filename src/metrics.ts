import { Counter, Histogram, Registry } from "prom-client";
const SECONDS = [5, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600];
const COUNTS = [0, 1, 2, 3, 5, 8, 13, 21, 34];
const MODEL = /^[A-Za-z0-9._:/-]{1,80}$/;
const ROLES = ["review", "scout", "reply"];
const MAX_RUNS = 16;

/** RunStats is what a job reports of one model run, from its run.json. */
export interface RunStats {
  role: string;
  model: string;
  submitted: boolean;
  error: string;
  durationMs: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  commands: number;
  failedCommands: number;
}

/** Verdicts is how one reviewer concluded on a commit, as its check run says. */
export interface Verdicts {
  /** pass, neutral, block or no_verdict. */
  verdict: string;
  findings: number;
  preExisting: number;
}

export type Metrics = ReturnType<typeof metrics>;

/** metrics builds the service's Prometheus metrics in a registry of their own. */
export function metrics() {
  const registry = new Registry();
  const counter = (name: string, help: string, labelNames: string[]) => new Counter({ name, help, labelNames, registers: [registry] });
  const histogram = (name: string, help: string, labelNames: string[], buckets: number[]) => new Histogram({ name, help, labelNames, buckets, registers: [registry] });
  return {
    registry,
    requests: counter("seidroid_requests_total", "Requests served, by route and status code.", ["route", "code"]),
    requestSeconds: histogram("seidroid_request_duration_seconds", "Time to serve a request, by route.", ["route"], [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]),
    refusals: counter("seidroid_refusals_total", "Requests refused for who or what sent them, by route and reason.", ["route", "reason"]),
    reviews: counter("seidroid_reviews_total", "Reviews published, by repository, mode, trigger, conclusion and what settled them.", ["repo", "mode", "trigger", "conclusion", "settled"]),
    reviewFailures: counter("seidroid_review_failures_total", "Reviews that reached no verdict, by repository and reason.", ["repo", "reason"]),
    reviewSeconds: histogram("seidroid_review_duration_seconds", "Time from the review job's start to its publish, by repository and mode.", ["repo", "mode"], SECONDS),
    findings: counter("seidroid_findings_total", "Findings reviews reported, by repository, mode and severity.", ["repo", "mode", "severity"]),
    placed: counter("seidroid_findings_placed_total", "Findings published, by repository and where they landed.", ["repo", "placement"]),
    replies: counter("seidroid_replies_total", "Replies posted, by repository and whether the model answered.", ["repo", "answered"]),
    runs: counter("seidroid_model_runs_total", "Model runs, by repository, role, model and result.", ["repo", "role", "model", "result"]),
    tokens: counter("seidroid_model_tokens_total", "Tokens model runs used, by repository, role, model and kind.", ["repo", "role", "model", "kind"]),
    cost: counter("seidroid_model_cost_usd_total", "What model runs cost in US dollars, as pi prices them, by repository, role and model.", ["repo", "role", "model"]),
    turns: histogram("seidroid_model_turns", "Assistant turns per model run, by repository, role and model.", ["repo", "role", "model"], [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]),
    runSeconds: histogram("seidroid_model_run_duration_seconds", "Time per model run, by repository, role and model.", ["repo", "role", "model"], SECONDS),
    commands: counter("seidroid_shell_commands_total", "Shell commands model runs ran, by repository, role and result.", ["repo", "role", "result"]),
    compared: counter("seidroid_comparisons_total", "Commits both v1 and v2 were asked to review, by repository and each one's verdict; v1 is missing when it never reviewed the commit.", ["repo", "v1", "v2"]),
    comparedFindings: histogram("seidroid_compared_findings", "Findings per commit both v1 and v2 reviewed, by repository and reviewer.", ["repo", "reviewer"], COUNTS),
    comparedSeconds: histogram("seidroid_compared_duration_seconds", "Review job time per commit both v1 and v2 reviewed and timed, by repository and reviewer.", ["repo", "reviewer"], SECONDS),
    first: counter("seidroid_compared_first_total", "Which reviewer published first on a compared commit, by repository.", ["repo", "reviewer"]),
  };
}

/** runStats reads a job's reported runs, keeping only well-formed ones within bounds. */
export function runStats(raw: unknown): RunStats[] {
  if (!Array.isArray(raw)) return [];
  const n = (x: unknown, max: number) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.min(x, max) : 0);
  return raw.slice(0, MAX_RUNS).flatMap((r) => {
    if (typeof r !== "object" || r === null || !ROLES.includes(r.role)) return [];
    return [{
      role: r.role,
      model: typeof r.model === "string" && MODEL.test(r.model) ? r.model : "other",
      submitted: r.submitted === true,
      error: typeof r.error === "string" ? r.error : "",
      durationMs: n(r.durationMs, 6 * 3600_000),
      turns: Math.floor(n(r.turns, 10_000)),
      input: n(r.input, 1e9),
      output: n(r.output, 1e9),
      cacheRead: n(r.cacheRead, 1e9),
      cacheWrite: n(r.cacheWrite, 1e9),
      cost: n(r.cost, 1e4),
      commands: Math.floor(n(r.commands, 10_000)),
      failedCommands: Math.floor(n(r.failedCommands, 10_000)),
    }];
  });
}

/** runResult names how a model run ended, from its error. */
export function runResult(r: Pick<RunStats, "submitted" | "error">): string {
  if (r.submitted) return "submitted";
  if (r.error.startsWith("timed out")) return "timeout";
  if (r.error.startsWith("no model credential")) return "credential";
  if (r.error.startsWith("the model ended without")) return "no_submit";
  if (r.error.startsWith("pi exited")) return "exit";
  return "error";
}

/** failureReason names why a review reached no verdict, from the reason it gives. */
export function failureReason(failure: string): string {
  if (failure.startsWith("the review did not finish: timed out")) return "timeout";
  if (failure.startsWith("the review did not finish")) return "unfinished";
  if (failure.includes("broke the contract")) return "contract";
  if (failure.includes("carried a credential")) return "credential";
  return "other";
}

/** recordRuns adds a job's model runs in repo to m. */
export function recordRuns(m: Metrics, repo: string, runs: readonly RunStats[]): void {
  for (const r of runs) {
    const l = { repo, role: r.role, model: r.model };
    m.runs.inc({ ...l, result: runResult(r) });
    for (const [kind, v] of [["input", r.input], ["output", r.output], ["cache_read", r.cacheRead], ["cache_write", r.cacheWrite]] as const) m.tokens.inc({ ...l, kind }, v);
    m.cost.inc(l, r.cost);
    m.turns.observe(l, r.turns);
    m.runSeconds.observe(l, r.durationMs / 1000);
    m.commands.inc({ repo, role: r.role, result: "ok" }, Math.max(0, r.commands - r.failedCommands));
    m.commands.inc({ repo, role: r.role, result: "failed" }, Math.min(r.commands, r.failedCommands));
  }
}

const NO_VERDICT = /^(No verdict|review did not complete|review produced but not published)/;
const FINDINGS = /^(\d+) findings?(?:, (\d+) pre-existing)?/;

/** verdicts reads a reviewer's verdict on a commit from its check run, the same way for v1 and v2. */
export function verdicts(c: { conclusion: string; title: string }): Verdicts {
  const m = FINDINGS.exec(c.title);
  const verdict = NO_VERDICT.test(c.title) || !m ? "no_verdict" : c.conclusion === "success" ? "pass" : c.conclusion === "neutral" ? "neutral" : "block";
  return { verdict, findings: m ? Number(m[1]) : 0, preExisting: m?.[2] ? Number(m[2]) : 0 };
}
