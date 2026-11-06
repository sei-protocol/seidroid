import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { all, client, type GitHub } from "./github.ts";
import type { PriorThread } from "./history.ts";
import { DIFF, INTENT, STANDARDS, TREE, type Request, type ScoutReading } from "./prompt.ts";
import { MARKER } from "./render.ts";
import { run } from "./run.ts";
import { readingOf, settleByScouts } from "./scout.ts";
import { scanSecrets } from "./secrets.ts";

/** Event is the part of a workflow run's trigger the guard reads. */
export interface Event {
  name: string;
  actor: string;
  payload: any;
}

export interface GuardOptions {
  phrase: string;
  skipLabel: string;
  reReviewOnPush: boolean;
  allowedBots: readonly string[];
}

/** Gate is the guard's answer: whether to review, and the pull request and comment it is for. */
export interface Gate {
  run: boolean;
  reason: string;
  pr: number;
  head: string;
}

export type Allow = (pr: number, comment?: number) => Promise<{ actor: boolean }>;

/** The audience of the OIDC tokens the job shows the seidroid service. */
const AUDIENCE = "seidroid";
const PUSH_ACTIONS = ["opened", "reopened", "ready_for_review", "synchronize"];

/** requested reports whether a comment asks for a review: a line holding just the phrase and "review". */
export const requested = (body: string, phrase: string): boolean =>
  body.split("\n").some((l) => l.trim().split(/\s+/).join(" ").toLowerCase() === `${phrase} review`.toLowerCase());

/** commentOf is the pull request a comment event is on, with the comment and its author, or undefined for any other event. */
function commentOf(ev: Event): { pr: number; body: string; id?: number; bot: boolean } | undefined {
  const p = ev.payload;
  if (ev.name === "issue_comment" && p.action === "created" && p.issue?.pull_request) {
    return { pr: p.issue.number, body: p.comment.body ?? "", id: p.comment.id, bot: p.comment.user?.type === "Bot" };
  }
  if (ev.name === "pull_request_review_comment" && p.action === "created") {
    return { pr: p.pull_request.number, body: p.comment.body ?? "", bot: p.comment.user?.type === "Bot" };
  }
  if (ev.name === "pull_request_review" && p.action === "submitted") {
    return { pr: p.pull_request.number, body: p.review.body ?? "", bot: p.review.user?.type === "Bot" };
  }
  return undefined;
}

/**
 * guard decides whether this event earns a review. A push reviews a ready, same-repository pull request once,
 * again on later pushes only with re-review on push or to lift this App's change request; a team member or an
 * allowed bot asks for one by comment at any time.
 */
export async function guard(ev: Event, o: GuardOptions, gh: GitHub, allow: Allow): Promise<Gate> {
  const deny = (pr: number, reason: string): Gate => ({ run: false, reason, pr, head: "" });
  const admit = (reason: string): Gate => ({ run: true, reason, pr, head: p.head.sha });
  const asked = commentOf(ev);
  let pr: number;
  if (ev.name === "pull_request") {
    pr = ev.payload.pull_request.number;
    if (!PUSH_ACTIONS.includes(ev.payload.action)) return deny(pr, `${ev.payload.action} does not start a review`);
  } else if (asked) {
    pr = asked.pr;
    if (!requested(asked.body, o.phrase)) return deny(pr, "the comment does not ask for a review");
    if (asked.bot ? !o.allowedBots.includes(ev.actor) : !(await allow(pr, asked.id)).actor) return deny(pr, `${ev.actor} may not ask for a review`);
  } else {
    return deny(0, `${ev.name} does not start a review`);
  }
  const base = `/repos/${ev.payload.repository.full_name}`;
  const pull = await gh.rest<any>("GET", `${base}/pulls/${pr}`);
  if (pull.status !== 200) throw new Error(`could not read pull request ${pr}: ${pull.status}`);
  const p = pull.data;
  if (p.state !== "open") return deny(pr, "the pull request is closed");
  if (p.head.repo?.id !== p.base.repo.id) return deny(pr, "the pull request comes from a fork");
  if (o.skipLabel && p.labels.some((l: { name: string }) => l.name === o.skipLabel)) return deny(pr, `the pull request has ${o.skipLabel}`);
  if (asked) return admit(`${ev.actor} asked for a review`);
  if (p.draft) return deny(pr, "the pull request is a draft");
  const reviews = await all<{ state: string; body: string; user: { type: string } }>(gh, `${base}/pulls/${pr}/reviews`);
  const ours = reviews.filter((r) => r.user.type === "Bot" && (r.body ?? "").startsWith(MARKER.verdict));
  if (!ours.length) return admit("the pull request has no review yet");
  if (ev.payload.action !== "synchronize") return deny(pr, "the pull request was already reviewed");
  if (o.reReviewOnPush) return admit("a push re-reviews");
  if (ours.at(-1)!.state === "CHANGES_REQUESTED") return admit("a push may lift the change request");
  return deny(pr, "the pull request was already reviewed");
}

const THREADS = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved path line originalLine comments(first: 50) { nodes { body author { __typename } } } }
  } } }
}`;

/** priorThreads reads the finding threads seidroid opened on the pull request, with their replies. */
export async function priorThreads(gh: GitHub, owner: string, repo: string, pr: number): Promise<PriorThread[]> {
  const out: PriorThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: any = await gh.graphql(THREADS, { owner, repo, pr, after });
    const threads = data.repository.pullRequest.reviewThreads;
    for (const t of threads.nodes) {
      const [first, ...replies] = t.comments.nodes as { body: string; author: { __typename: string } | null }[];
      if (first?.author?.__typename !== "Bot" || !first.body.startsWith(MARKER.finding)) continue;
      out.push({
        id: t.id,
        file: t.path,
        line: t.line ?? t.originalLine ?? 0,
        body: first.body.slice(MARKER.finding.length).trim(),
        replies: replies.map((r) => r.body),
        resolved: t.isResolved,
      });
    }
    if (!threads.pageInfo.hasNextPage) break;
    after = threads.pageInfo.endCursor;
  }
  return out;
}

/** oidc mints a GitHub Actions OIDC token for audience. */
async function oidc(audience: string): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("the job needs id-token: write");
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`the GitHub OIDC token request failed with ${res.status}`);
  return ((await res.json()) as { value: string }).value;
}

/** service calls a seidroid service route under a fresh OIDC token and returns its answer. */
async function service(url: string, route: string, body: unknown): Promise<any> {
  const res = await fetch(new URL(route, url), {
    method: "POST",
    headers: { Authorization: `Bearer ${await oidc(AUDIENCE)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const got: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`seidroid ${route} answered ${res.status}: ${got.error ?? ""}`);
  return got;
}

const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });

/** changedLines counts the added and removed lines in a diff's hunks. */
export function changedLines(diff: string): number {
  let n = 0;
  let hunk = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) hunk = false;
    else if (l.startsWith("@@")) hunk = true;
    else if (hunk && (l[0] === "+" || l[0] === "-")) n++;
  }
  return n;
}

/** lay writes what the prompts name into work: the diff, the standards at the base, and the pull request's intent. */
function lay(work: string, pull: any): { diffLines: number; hasStandards: boolean } {
  const tree = path.join(work, TREE);
  const diff = git(tree, "diff", "--no-ext-diff", `${git(tree, "merge-base", pull.base.sha, pull.head.sha).trim()}..${pull.head.sha}`);
  writeFileSync(path.join(work, DIFF), diff);
  let standards = "";
  try {
    standards = git(tree, "show", `${pull.base.sha}:REVIEW.md`);
  } catch {}
  if (standards) writeFileSync(path.join(work, STANDARDS), standards);
  writeFileSync(path.join(work, INTENT), `# ${pull.title}\n\n${pull.body ?? ""}\n`);
  return { diffLines: changedLines(diff), hasStandards: standards !== "" };
}

const lines = (s: string): string[] => s.split(/[\s,]+/).filter((x) => x !== "");
const submitted = (dir: string): unknown => (existsSync(path.join(dir, "submission.json")) ? JSON.parse(readFileSync(path.join(dir, "submission.json"), "utf8")) : undefined);
const failed = (dir: string): string => JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")).error || "it did not submit";

/** review runs the scouts, then the review unless the scouts settle it, and publishes the outcome through the service. */
async function review(o: Record<string, string>): Promise<void> {
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
  const gh = client(process.env.GITHUB_TOKEN!);
  const pr = Number(o.pr);
  const got = await gh.rest<any>("GET", `/repos/${owner}/${repo}/pulls/${pr}`);
  if (got.status !== 200) throw new Error(`could not read pull request ${pr}: ${got.status}`);
  const pull = { ...got.data, head: { ...got.data.head, sha: o.head } };
  const work = path.resolve(o.work);
  const { diffLines, hasStandards } = lay(work, pull);
  process.chdir(work);
  const timeoutMs = Number(o["timeout-seconds"]) * 1000;

  const scouts: ScoutReading[] = await Promise.all(
    lines(o["scout-models"]).map(async (model, i) => {
      const dir = path.join(o.out, `scout-${i}`);
      await run({ role: "scout", request: { repo: `${owner}/${repo}`, pr, diffLines }, outDir: dir, model, thinking: o.thinking, timeoutMs });
      return readingOf(model, (submitted(dir) as any) ?? failed(dir));
    }),
  );
  const settled = settleByScouts(scouts, diffLines);
  const includeNits = pull.labels.some((l: { name: string }) => l.name === o["nitpick-label"]);
  let outcome: unknown;
  if (settled) {
    outcome = { submission: settled, settledBy: scouts.map((s) => s.name).join(", ") };
  } else {
    const threads = await priorThreads(gh, owner, repo, pr);
    const request: Request = { repo: `${owner}/${repo}`, pr, diffLines, hasTree: true, hasStandards, includeNits, extraInstructions: o["extra-instructions"] || undefined, scouts, threads };
    const dir = path.join(o.out, "review");
    await run({ role: "review", request, outDir: dir, model: o["review-model"], thinking: o.thinking, timeoutMs, sessionDir: o["session-dir"] || undefined });
    const s = submitted(dir);
    outcome = s ? { submission: s } : { failure: `the review did not finish: ${failed(dir)}` };
  }
  const held = ["GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_RUNTIME_TOKEN", "OPENAI_API_KEY"].map((k) => process.env[k] ?? "");
  if (scanSecrets(JSON.stringify(outcome), held)) outcome = { failure: "the review's answer carried a credential, so it was withheld" };
  const report = await service(o.service, "/publish", { pr, head: pull.head.sha, outcome, includeNits, shadow: o.shadow !== "false" });
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `seidroid: ${report.conclusion}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
}

const OPTIONS = [
  "service", "trigger-phrase", "skip-review-label", "re-review-on-push", "allowed-bots",
  "pr", "head", "work", "out", "session-dir", "review-model", "scout-models", "thinking", "timeout-seconds", "nitpick-label", "extra-instructions", "shadow",
];

async function main(): Promise<void> {
  const { positionals, values: o } = parseArgs({ allowPositionals: true, options: Object.fromEntries(OPTIONS.map((k) => [k, { type: "string" as const, default: "" }])) });
  if (positionals[0] === "review") return review(o);
  if (positionals[0] !== "guard") throw new Error("usage: job.ts guard|review [--option value ...]");
  const ev: Event = { name: process.env.GITHUB_EVENT_NAME!, actor: process.env.GITHUB_ACTOR!, payload: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")) };
  const opts = { phrase: o["trigger-phrase"], skipLabel: o["skip-review-label"], reReviewOnPush: o["re-review-on-push"] === "true", allowedBots: lines(o["allowed-bots"]) };
  const gate = await guard(ev, opts, client(process.env.GITHUB_TOKEN!), (pr, comment) => service(o.service, "/allow", { pr, comment }));
  console.log(gate.reason);
  appendFileSync(process.env.GITHUB_OUTPUT!, `run=${gate.run}\npr=${gate.pr}\nhead=${gate.head}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
