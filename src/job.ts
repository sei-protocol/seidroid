import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { all, client, type GitHub } from "./github.ts";
import type { PriorThread } from "./history.ts";
import { DIFF, INTENT, STANDARDS, TREE, type Request, type ScoutReading } from "./prompt.ts";
import { MARKER } from "./render.ts";
import { run } from "./run.ts";
import { bwrapArgs, canSandbox } from "./sandbox.ts";
import { QUESTION, type ReplySubmission } from "./reply.ts";
import { readingOf, settleByScouts } from "./scout.ts";
import { scanSecrets } from "./secrets.ts";
import { clip } from "./text.ts";

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
  /** In shadow, v1 answers comments, so seidroid only reviews. */
  shadow: boolean;
}

/** Gate is the guard's answer: whether to review or to reply, and the pull request and comment it is for. */
export interface Gate {
  run: boolean;
  reply: boolean;
  reason: string;
  pr: number;
  head: string;
  comment: number;
}

export type Allow = (pr: number, comment?: number) => Promise<{ actor: boolean }>;

/** The audience of the OIDC tokens the job shows the seidroid service. */
const AUDIENCE = "seidroid";
const PUSH_ACTIONS = ["opened", "reopened", "ready_for_review", "synchronize"];

/** requested reports whether a comment asks for a review: a line holding just the phrase and "review". */
export const requested = (body: string, phrase: string): boolean =>
  body.split("\n").some((l) => l.trim().split(/\s+/).join(" ").toLowerCase() === `${phrase} review`.toLowerCase());

/** reserved reports whether a comment holds a review command seidroid v1 handles, such as "review close". */
const reserved = (body: string, phrase: string): boolean => {
  const close = `${phrase} review close`.toLowerCase();
  return body.split("\n").some((l) => {
    const line = l.trim().split(/\s+/).join(" ").toLowerCase();
    return line === close || line.startsWith(`${close} `);
  });
};

/** commentOf is the pull request a comment event is on, with the comment and its author, or undefined for any other event. */
function commentOf(ev: Event): { pr: number; body: string; id: number; bot: boolean } | undefined {
  const p = ev.payload;
  if (ev.name === "issue_comment" && p.action === "created" && p.issue?.pull_request) {
    return { pr: p.issue.number, body: p.comment.body ?? "", id: p.comment.id, bot: p.comment.user?.type === "Bot" };
  }
  if (ev.name === "pull_request_review_comment" && p.action === "created") {
    return { pr: p.pull_request.number, body: p.comment.body ?? "", id: p.comment.id, bot: p.comment.user?.type === "Bot" };
  }
  if (ev.name === "pull_request_review" && p.action === "submitted") {
    return { pr: p.pull_request.number, body: p.review.body ?? "", id: p.review.id, bot: p.review.user?.type === "Bot" };
  }
  return undefined;
}

/**
 * guard decides whether this event earns a review. A push reviews a ready, same-repository pull request once,
 * again on later pushes only with re-review on push or to lift this App's change request; a team member or an
 * allowed bot asks for one by comment at any time. Any other comment from a team member that mentions the phrase
 * earns a reply, outside shadow.
 */
export async function guard(ev: Event, o: GuardOptions, gh: GitHub, allow: Allow): Promise<Gate> {
  const deny = (pr: number, reason: string): Gate => ({ run: false, reply: false, reason, pr, head: "", comment: 0 });
  const admit = (reason: string): Gate => ({ run: true, reply: false, reason, pr, head: p.head.sha, comment: 0 });
  const asked = commentOf(ev);
  const question = asked !== undefined && !requested(asked.body, o.phrase);
  let pr: number;
  if (ev.name === "pull_request") {
    pr = ev.payload.pull_request.number;
    if (!PUSH_ACTIONS.includes(ev.payload.action)) return deny(pr, `${ev.payload.action} does not start a review`);
  } else if (asked) {
    pr = asked.pr;
    if (question) {
      if (!asked.body.toLowerCase().includes(o.phrase.toLowerCase()) || reserved(asked.body, o.phrase)) return deny(pr, "the comment does not ask seidroid anything");
      if (o.shadow) return deny(pr, "in shadow, seidroid leaves comments to v1");
      if (asked.bot) return deny(pr, "seidroid does not answer bots");
    }
    const react = ev.name === "issue_comment" ? asked.id : undefined;
    if (asked.bot ? !o.allowedBots.includes(ev.actor) : !(await allow(pr, react)).actor) return deny(pr, `${ev.actor} may not ask seidroid`);
  } else {
    return deny(0, `${ev.name} does not start a review`);
  }
  const base = `/repos/${ev.payload.repository.full_name}`;
  const pull = await gh.rest<any>("GET", `${base}/pulls/${pr}`);
  if (pull.status !== 200) throw new Error(`could not read pull request ${pr}: ${pull.status}`);
  const p = pull.data;
  if (p.state !== "open") return deny(pr, "the pull request is closed");
  if (p.head.repo?.id !== p.base.repo.id) return deny(pr, "the pull request comes from a fork");
  if (question) return { run: false, reply: true, reason: `${ev.actor} asked seidroid`, pr, head: p.head.sha, comment: asked.id };
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

const MAX_SAID = 8_000;
const MAX_THREAD = 20;
const MAX_EARLIER = 30;
const MAX_EARLIER_SAID = 2_000;

interface Said {
  id: number;
  in_reply_to_id?: number;
  user: { login: string } | null;
  body?: string | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string;
  created_at?: string;
  submitted_at?: string;
}

const who = (c: Said): string => c.user?.login ?? "ghost";
const said = (c: Said, max = MAX_SAID): string => `**${who(c)}:**\n\n${clip(c.body ?? "", max)}\n`;

/**
 * earlier is the pull request's conversation before at, oldest first and only the latest
 * MAX_EARLIER of it: comments, review bodies and comments on the code, less those skip names.
 */
async function earlier(gh: GitHub, base: string, pr: number, at: string, code: Said[], skip: (c: Said) => boolean): Promise<string[]> {
  const [comments, reviews] = await Promise.all([all<Said>(gh, `${base}/issues/${pr}/comments`), all<Said>(gh, `${base}/pulls/${pr}/reviews`)]);
  const talk = [
    ...comments.map((c) => ({ at: c.created_at, text: said(c, MAX_EARLIER_SAID), c })),
    ...reviews.filter((r) => r.body).map((r) => ({ at: r.submitted_at, text: said(r, MAX_EARLIER_SAID), c: r })),
    ...code.map((c) => ({ at: c.created_at, text: `**${who(c)}** on ${c.path}, line ${c.line ?? c.original_line}:\n\n${clip(c.body ?? "", MAX_EARLIER_SAID)}\n`, c })),
  ].filter((t) => t.at !== undefined && t.at < at && !skip(t.c));
  talk.sort((a, b) => a.at!.localeCompare(b.at!));
  const shown = talk.slice(-MAX_EARLIER).map((t) => t.text);
  if (shown.length === 0) return [];
  const dropped = talk.length - shown.length;
  return ["# The conversation so far", "", ...(dropped > 0 ? [`(${dropped} earlier comments are not shown.)`, ""] : []), ...shown, ""];
}

/**
 * conversation is what the reply needs to read: the pull request's conversation so far, then
 * the comment to answer, with the review thread it ends when it was left on the code.
 */
export async function conversation(gh: GitHub, base: string, pr: number, event: string, id: number): Promise<string> {
  const code = await all<Said>(gh, `${base}/pulls/${pr}/comments`);
  if (event === "pull_request_review_comment") {
    const root = code.find((c) => c.id === id)?.in_reply_to_id ?? id;
    const whole = new Set(code.filter((c) => c.id === root || c.in_reply_to_id === root));
    const thread = [...whole].filter((c) => c.id <= id);
    const top = thread[0];
    const asked = thread.at(-1);
    if (top?.id !== root || asked?.id !== id) throw new Error(`comment ${id} is not on pull request ${pr}`);
    const where = `${top.path}, line ${top.line ?? top.original_line}`;
    return [
      ...(await earlier(gh, base, pr, asked.created_at ?? "", code, (c) => whole.has(c))),
      `# A review thread on ${where}`, "", "````diff", clip(top.diff_hunk ?? "", MAX_SAID), "````", "", ...thread.slice(-MAX_THREAD).map((c) => said(c)),
    ].join("\n");
  }
  const review = event !== "issue_comment";
  const got = await gh.rest<Said>("GET", review ? `${base}/pulls/${pr}/reviews/${id}` : `${base}/issues/comments/${id}`);
  if (got.status !== 200) throw new Error(`could not read comment ${id}: ${got.status}`);
  const at = (review ? got.data.submitted_at : got.data.created_at) ?? "";
  return [...(await earlier(gh, base, pr, at, code, () => false)), "# The comment to answer", "", said(got.data)].join("\n");
}

const lines = (s: string): string[] => s.split(/[\s,]+/).filter((x) => x !== "");
const submitted = (dir: string): unknown => (existsSync(path.join(dir, "submission.json")) ? JSON.parse(readFileSync(path.join(dir, "submission.json"), "utf8")) : undefined);
const failed = (dir: string): string => JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")).error || "it did not submit";

const held = (): string[] => ["GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_RUNTIME_TOKEN", "OPENAI_API_KEY"].map((k) => process.env[k] ?? "");

/** pullAt reads the pull request with its head pinned to the commit the guard saw. */
async function pullAt(gh: GitHub, base: string, pr: number, head: string): Promise<any> {
  const got = await gh.rest<any>("GET", `${base}/pulls/${pr}`);
  if (got.status !== 200) throw new Error(`could not read pull request ${pr}: ${got.status}`);
  return { ...got.data, head: { ...got.data.head, sha: head } };
}

const PREPARE_MS = 15 * 60_000;

/**
 * shellHome readies the review's sandboxed shell and returns its home, after running the
 * caller's prepare command in the tree with the network; undefined when no shell is asked
 * for or the runner cannot sandbox one.
 */
function shellHome(o: Record<string, string>, work: string): string | undefined {
  if (!o.home) return undefined;
  if (!canSandbox()) {
    console.log("::warning::bubblewrap cannot sandbox a shell here, so the review only reads");
    return undefined;
  }
  mkdirSync(o.home, { recursive: true });
  if (o.prepare) {
    const jail = { work: path.join(work, TREE), home: o.home, path: process.env.PATH ?? "/usr/bin:/bin", net: true };
    const stop = randomUUID();
    console.log(`::stop-commands::${stop}`);
    const r = spawnSync("bwrap", [...bwrapArgs(jail), "bash", "-c", o.prepare], { stdio: ["ignore", "inherit", "inherit"], timeout: PREPARE_MS, env: { PATH: jail.path } });
    console.log(`::${stop}::`);
    if (r.status !== 0) console.log(`::warning::prepare failed (${r.error?.message ?? `exit ${r.status}`}), so the review's shell may lack what the tree needs`);
  }
  return o.home;
}

/** review runs the scouts, then the review unless the scouts settle it, and publishes the outcome through the service. */
async function review(o: Record<string, string>): Promise<void> {
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
  const gh = client(process.env.GITHUB_TOKEN!);
  const pr = Number(o.pr);
  const pull = await pullAt(gh, `/repos/${owner}/${repo}`, pr, o.head);
  const work = path.resolve(o.work);
  const { diffLines, hasStandards } = lay(work, pull);
  const home = shellHome(o, work);
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
    const request: Request = { repo: `${owner}/${repo}`, pr, diffLines, hasTree: true, hasStandards, hasShell: home !== undefined, includeNits, extraInstructions: o["extra-instructions"] || undefined, scouts, threads };
    const dir = path.join(o.out, "review");
    await run({ role: "review", request, outDir: dir, model: o["review-model"], thinking: o.thinking, timeoutMs, sessionDir: o["session-dir"] || undefined, home });
    const s = submitted(dir);
    outcome = s ? { submission: s } : { failure: `the review did not finish: ${failed(dir)}` };
  }
  if (scanSecrets(JSON.stringify(outcome), held())) outcome = { failure: "the review's answer carried a credential, so it was withheld" };
  const report = await service(o.service, "/publish", { pr, head: pull.head.sha, outcome, includeNits, shadow: o.shadow !== "false", aiReviewCheck: o["ai-review-check"] === "true" });
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `seidroid: ${report.conclusion}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
}

/** reply answers the comment that asked seidroid, in its thread, through the service. */
async function reply(o: Record<string, string>): Promise<void> {
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
  const gh = client(process.env.GITHUB_TOKEN!);
  const base = `/repos/${owner}/${repo}`;
  const pr = Number(o.pr);
  const comment = Number(o.comment);
  const work = path.resolve(o.work);
  const { diffLines } = lay(work, await pullAt(gh, base, pr, o.head));
  writeFileSync(path.join(work, QUESTION), await conversation(gh, base, pr, process.env.GITHUB_EVENT_NAME!, comment));
  process.chdir(work);
  const dir = path.join(o.out, "reply");
  const request = { repo: `${owner}/${repo}`, pr, diffLines, extraInstructions: o["extra-instructions"] || undefined };
  await run({ role: "reply", request, outDir: dir, model: o["review-model"], thinking: o.thinking, timeoutMs: Number(o["timeout-seconds"]) * 1000 });
  const s = submitted(dir) as ReplySubmission | undefined;
  let body = s ? s.body : `I could not answer this: ${failed(dir)}.`;
  if (scanSecrets(body, held())) body = "My answer carried a credential, so I withheld it.";
  writeFileSync(path.join(dir, "reply.md"), body);
  console.log((await service(o.service, "/reply", { pr, comment, body })).url);
}

const OPTIONS = [
  "service", "trigger-phrase", "skip-review-label", "re-review-on-push", "allowed-bots",
  "pr", "head", "work", "out", "session-dir", "review-model", "scout-models", "thinking", "timeout-seconds", "nitpick-label", "extra-instructions", "shadow", "comment", "ai-review-check", "home", "prepare",
];

async function main(): Promise<void> {
  const { positionals, values: o } = parseArgs({ allowPositionals: true, options: Object.fromEntries(OPTIONS.map((k) => [k, { type: "string" as const, default: "" }])) });
  if (positionals[0] === "review") return review(o);
  if (positionals[0] === "reply") return reply(o);
  if (positionals[0] !== "guard") throw new Error("usage: job.ts guard|review|reply [--option value ...]");
  const ev: Event = { name: process.env.GITHUB_EVENT_NAME!, actor: process.env.GITHUB_ACTOR!, payload: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")) };
  const opts = { phrase: o["trigger-phrase"], skipLabel: o["skip-review-label"], reReviewOnPush: o["re-review-on-push"] === "true", allowedBots: lines(o["allowed-bots"]), shadow: o.shadow !== "false" };
  const gate = await guard(ev, opts, client(process.env.GITHUB_TOKEN!), (pr, comment) => service(o.service, "/allow", { pr, comment }));
  console.log(gate.reason);
  appendFileSync(process.env.GITHUB_OUTPUT!, `run=${gate.run}\nreply=${gate.reply}\npr=${gate.pr}\nhead=${gate.head}\ncomment=${gate.comment}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
