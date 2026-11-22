import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { all, client, type GitHub } from "./github.ts";
import type { PriorThread } from "./history.ts";
import { DIFF, INTENT, SINCE, STANDARDS, TREE, type Request, type ScoutReading } from "./prompt.ts";
import { MARKER } from "./render.ts";
import { hasSession, run, sha256 } from "./run.ts";
import { bwrapArgs, canSandbox } from "./sandbox.ts";
import { QUESTION, type ReplySubmission } from "./reply.ts";
import { carriesOn, readingOf, ScoutSubmission, settleByScouts, type ScoutRequest } from "./scout.ts";
import { scanSecrets } from "./secrets.ts";
import { MAX_SESSION, pack, unpack } from "./session.ts";
import { clip, guidelinesPath } from "./text.ts";

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
  /** ask is what the comment that asked for this review says beside the command. */
  ask: string;
}

export type Allow = (pr: number, comment?: number) => Promise<{ actor: boolean; author: boolean }>;

/** Standing is how seidroid's latest review on a pull request ended. */
export type Standing = "changes_requested" | "reviewed";

/** OwnReviews reads how seidroid's latest review on a pull request ended from its own check runs, or undefined when it has none. */
export type OwnReviews = (pr: number) => Promise<Standing | undefined>;

const PUSH_ACTIONS = ["opened", "reopened", "ready_for_review", "synchronize"];

/** commands are a comment's lines, normalised for matching a command: whitespace collapsed, lower case, no leading @. */
const commands = (body: string): string[] => body.split("\n").map((l) => l.trim().split(/\s+/).join(" ").toLowerCase().replace(/^@/, ""));

/** bare is the trigger phrase without its @, which a command may leave out. */
const bare = (phrase: string): string => phrase.toLowerCase().replace(/^@/, "");

/** requested reports whether a comment asks for a review: a line holding just the phrase, with or without its @, and "review". */
export const requested = (body: string, phrase: string): boolean => commands(body).includes(`${bare(phrase)} review`);

const MAX_ASK = 4000;

/** besides is a review request's text without its command lines, trimmed and clipped. */
export const besides = (body: string, phrase: string): string => {
  const command = `${bare(phrase)} review`;
  const lines = commands(body);
  return clip(body.split("\n").filter((_, i) => lines[i] !== command).join("\n").trim(), MAX_ASK);
};

/** reserved reports whether a comment holds a review command seidroid v1 handles, such as "review close". */
const reserved = (body: string, phrase: string): boolean => {
  const close = `${bare(phrase)} review close`;
  return commands(body).some((line) => line === close || line.startsWith(`${close} `));
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
 * earns a reply, outside shadow. In shadow, v1 posts its reviews as the same App, so seidroid's own reviews are
 * read from its check runs instead.
 */
export async function guard(ev: Event, o: GuardOptions, gh: GitHub, allow: Allow, ownReviews: OwnReviews): Promise<Gate> {
  const deny = (pr: number, reason: string): Gate => ({ run: false, reply: false, reason, pr, head: "", comment: 0, ask: "" });
  const admit = (reason: string): Gate => ({ run: true, reply: false, reason, pr, head: p.head.sha, comment: 0, ask: "" });
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
  if (question) return { run: false, reply: true, reason: `${ev.actor} asked seidroid`, pr, head: p.head.sha, comment: asked.id, ask: "" };
  if (o.skipLabel && p.labels.some((l: { name: string }) => l.name === o.skipLabel)) return deny(pr, `the pull request has ${o.skipLabel}`);
  if (asked) return { ...admit(`${ev.actor} asked for a review`), comment: asked.id, ask: asked.bot ? "" : besides(asked.body, o.phrase) };
  if (p.draft) return deny(pr, "the pull request is a draft");
  if (!(await allow(pr)).author) return deny(pr, `${p.user.login} is not on the team, so a team member must ask for this review`);
  const last = o.shadow ? await ownReviews(pr) : await lastReview(gh, base, pr);
  if (!last) return admit("the pull request has no review yet");
  if (ev.payload.action !== "synchronize") return deny(pr, "the pull request was already reviewed");
  if (o.reReviewOnPush) return admit("a push re-reviews");
  if (last === "changes_requested") return admit("a push may lift the change request");
  return deny(pr, "the pull request was already reviewed");
}

/** lastReview is how this App's latest review on the pull request ended, or undefined when it has none. */
async function lastReview(gh: GitHub, base: string, pr: number): Promise<Standing | undefined> {
  const reviews = await all<{ state: string; body: string; user: { type: string } }>(gh, `${base}/pulls/${pr}/reviews`);
  const ours = reviews.filter((r) => r.user.type === "Bot" && (r.body ?? "").startsWith(MARKER.verdict));
  if (!ours.length) return undefined;
  return ours.at(-1)!.state === "CHANGES_REQUESTED" ? "changes_requested" : "reviewed";
}

/** standingOf reads how seidroid's latest review ended from the conclusion of its latest check run that records one, as /history answers it. */
export function standingOf(history: { conclusion?: unknown }): Standing | undefined {
  if (history.conclusion === undefined) throw new Error("the seidroid service does not report its latest review; it predates this workflow");
  if (history.conclusion === null) return undefined;
  return history.conclusion === "failure" ? "changes_requested" : "reviewed";
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

/**
 * earlierFindings reads seidroid's earlier findings on the pull request: its finding threads, or in
 * shadow, where those threads are v1's, what its own check runs recorded. It reads none in shadow
 * when the service cannot answer.
 */
export async function earlierFindings(gh: GitHub, url: string, owner: string, repo: string, pr: number, shadow: boolean): Promise<PriorThread[]> {
  if (!shadow) return priorThreads(gh, owner, repo, pr);
  try {
    const { threads } = await service(url, "/history", { pr });
    return Array.isArray(threads) ? threads : [];
  } catch (e) {
    console.log(`::warning::could not read seidroid's earlier findings: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
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

/** service calls a seidroid service route under a fresh OIDC token issued for the service's origin, and returns its answer. */
export async function service(url: string, route: string, body: unknown): Promise<any> {
  const res = await fetch(new URL(route, url), {
    method: "POST",
    headers: { Authorization: `Bearer ${await oidc(new URL(url).origin)}`, "Content-Type": "application/json" },
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

/** lay writes what the prompts name into work: the diff, the guidelines file at the base as the standards, and the pull request's intent. */
function lay(work: string, pull: any, guidelines = "REVIEW.md"): { diffLines: number; hasStandards: boolean; base: string } {
  const tree = path.join(work, TREE);
  const base = git(tree, "merge-base", pull.base.sha, pull.head.sha).trim();
  const diff = git(tree, "diff", "--no-ext-diff", `${base}..${pull.head.sha}`);
  writeFileSync(path.join(work, DIFF), diff);
  let standards = "";
  try {
    standards = git(tree, "show", `${pull.base.sha}:${guidelines}`);
  } catch {}
  if (standards) writeFileSync(path.join(work, STANDARDS), standards);
  writeFileSync(path.join(work, INTENT), `# ${pull.title}\n\n${pull.body ?? ""}\n`);
  return { diffLines: changedLines(diff), hasStandards: standards !== "", base };
}

/** SCOUTED is the file in a review session that records what each scout last read. */
const SCOUTED = "scouts.json";
const Sha = Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" });
const Scouted = Type.Object({ head: Sha, base: Sha, readings: Type.Record(Type.String(), ScoutSubmission) }, { additionalProperties: false });
export type Scouted = Static<typeof Scouted>;

/** lastScouted is what the scouts read at the last review in a restored session, or undefined when there is none. */
export function lastScouted(sessionDir?: string): Scouted | undefined {
  if (!sessionDir || !hasSession(sessionDir)) return undefined;
  try {
    const s: unknown = JSON.parse(readFileSync(path.join(sessionDir, SCOUTED), "utf8"));
    return Value.Check(Scouted, s) ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * changesSince is the pull request's diff from last.head to head, with last.head first rebased
 * onto base so that what the base branch brought in is left out. It is undefined when last.head
 * is not in the tree or does not rebase cleanly, as after a force-push.
 */
export function changesSince(tree: string, last: Scouted, base: string, head: string): string | undefined {
  try {
    const rebased = git(tree, "merge-tree", "--write-tree", `--merge-base=${last.base}`, base, last.head).split("\n")[0];
    return git(tree, "diff", "--no-ext-diff", rebased, head);
  } catch {
    return undefined;
  }
}

/**
 * FULL_READ_ABOVE is the most changed lines a pull request may have for a scout to read only what
 * changed since its last reading; above it, a scout that reads only the change anchors on what it
 * found before and misses what reading the whole diff again finds.
 */
export const FULL_READ_ABOVE = 500;

/** readsSince is whether a scout reads only a change of changed lines rather than all diffLines again: when the diff is at most FULL_READ_ABOVE and the change small next to it. */
export const readsSince = (changed: number, diffLines: number): boolean => diffLines <= FULL_READ_ABOVE && changed <= diffLines / 4;

/**
 * scoutPlan is how a scout that read an earlier head reads this one, given what changed since
 * (undefined when that is unknown) and whether the base is the one it read against: on the same
 * base it keeps its reading when nothing changed and reads the change on its own when readsSince
 * it; otherwise it reads the whole diff.
 */
export function scoutPlan(diff: string | undefined, sameBase: boolean, diffLines: number): "keep" | "since" | "whole" {
  if (diff === undefined || !sameBase) return "whole";
  if (diff === "") return "keep";
  return readsSince(changedLines(diff), diffLines) ? "since" : "whole";
}

/** readAll is whether got is a reading of at least the asked lines, so the next push can build on it. */
export const readAll = (got: ScoutSubmission | string, asked: number): got is ScoutSubmission =>
  Value.Check(ScoutSubmission, got) && got.read > 0 && got.read >= asked;

/**
 * scout gets a reading from each scout model. When sessionDir holds what the scouts read at an
 * earlier head, a scout that read that head keeps its reading or reads only the change (SINCE)
 * along with what it found then, as scoutPlan allows and when carriesOn those findings; every
 * other scout reads the whole diff. since says whether any reading built on an earlier one.
 * Each reading of everything a scout was asked to read is kept in sessionDir for the next push.
 */
export async function scout(o: { models: string[]; request: ScoutRequest; work: string; out: string; sessionDir?: string; base: string; head: string; thinking: string; timeoutMs: number; transcript: boolean }): Promise<{ readings: ScoutReading[]; since: boolean }> {
  const last = lastScouted(o.sessionDir);
  const diff = last && changesSince(path.join(o.work, TREE), last, o.base, o.head);
  const plan = last ? scoutPlan(diff, last.base === o.base, o.request.diffLines) : "whole";
  if (plan === "since") writeFileSync(path.join(o.work, SINCE), diff!);
  const runs = await Promise.all(
    o.models.map(async (model, i): Promise<{ got: ScoutSubmission | string; asked: number; since: boolean }> => {
      const earlier = plan === "whole" ? undefined : last!.readings[model];
      if (earlier && plan === "keep") return { got: earlier, asked: earlier.read, since: true };
      const sinceLines = earlier && carriesOn(earlier.findings) ? Math.max(1, changedLines(diff!)) : undefined;
      const request = sinceLines === undefined ? o.request : { ...o.request, since: { lines: sinceLines, findings: earlier!.findings } };
      const dir = path.join(o.out, `scout-${i}`);
      await run({ role: "scout", request, outDir: dir, model, thinking: o.thinking, timeoutMs: o.timeoutMs, transcript: o.transcript });
      return { got: (submitted(dir) as ScoutSubmission | undefined) ?? failed(dir), asked: sinceLines ?? o.request.diffLines, since: sinceLines !== undefined };
    }),
  );
  if (o.sessionDir) {
    const readings = Object.fromEntries(o.models.flatMap((m, i) => (readAll(runs[i].got, runs[i].asked) ? [[m, runs[i].got]] : [])));
    mkdirSync(o.sessionDir, { recursive: true });
    writeFileSync(path.join(o.sessionDir, SCOUTED), JSON.stringify({ head: o.head, base: o.base, readings }));
  }
  return { readings: o.models.map((m, i) => readingOf(m, runs[i].got)), since: runs.some((r) => r.since) };
}

/** keepsTranscripts is whether the runs keep their transcripts: only for a repository known to be private, since anyone can read a public one's artifacts. */
export const keepsTranscripts = (o: Record<string, string>): boolean => o.private === "true";

/** recordInputs writes inputs.json to out: the commits reviewed and the SHA-256 of each file laid in work for the model to read. */
export function recordInputs(out: string, work: string, pull: any): void {
  const files = [DIFF, STANDARDS, INTENT, QUESTION].filter((f) => existsSync(path.join(work, f)));
  const sha = Object.fromEntries(files.map((f) => [f, sha256(readFileSync(path.join(work, f)))]));
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "inputs.json"), JSON.stringify({ base: pull.base.sha, head: pull.head.sha, sha256: sha }));
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

/** runsIn reports the model runs under out for the service's metrics: their run.json, with the commands counted rather than listed. */
export function runsIn(out: string): object[] {
  return readdirSync(out, { withFileTypes: true }).flatMap((d) => {
    const file = path.join(out, d.name, "run.json");
    if (!d.isDirectory() || !existsSync(file)) return [];
    const { commands = [], ...r } = JSON.parse(readFileSync(file, "utf8"));
    return [{ ...r, commands: commands.length, failedCommands: commands.filter((c: { failed?: boolean }) => c.failed).length }];
  });
}

const held = (): string[] => ["GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_RUNTIME_TOKEN", "OPENAI_API_KEY"].map((k) => process.env[k] ?? "");

/** pullAt reads the pull request with its head pinned to the commit the guard saw. */
async function pullAt(gh: GitHub, base: string, pr: number, head: string): Promise<any> {
  const got = await gh.rest<any>("GET", `${base}/pulls/${pr}`);
  if (got.status !== 200) throw new Error(`could not read pull request ${pr}: ${got.status}`);
  return { ...got.data, head: { ...got.data.head, sha: head } };
}

const PREPARE_MS = 15 * 60_000;

/**
 * shellHome readies the sandboxed shell of a review or reply and returns its home, after running the
 * caller's prepare command in the tree with the network; undefined when no shell is asked
 * for or the runner cannot sandbox one.
 */
function shellHome(o: Record<string, string>, work: string): string | undefined {
  if (!o.home) return undefined;
  if (!canSandbox()) {
    console.log("::warning::bubblewrap cannot sandbox a shell here, so the model only reads");
    return undefined;
  }
  mkdirSync(o.home, { recursive: true });
  if (o.prepare) {
    const jail = { work: path.join(work, TREE), home: o.home, path: process.env.PATH ?? "/usr/bin:/bin", net: true };
    const stop = randomUUID();
    console.log(`::stop-commands::${stop}`);
    const r = spawnSync("bwrap", [...bwrapArgs(jail), "bash", "-c", o.prepare], { stdio: ["ignore", "inherit", "inherit"], timeout: PREPARE_MS, env: { PATH: jail.path } });
    console.log(`::${stop}::`);
    if (r.status !== 0) console.log(`::warning::prepare failed (${r.error?.message ?? `exit ${r.status}`}), so the shell may lack what the tree needs`);
  }
  return o.home;
}

/** SessionState is how a run got the pull request's session: restored, none kept yet, off when the service keeps none, or unavailable. */
export type SessionState = "restored" | "none" | "off" | "unavailable";

/** SessionOf names the pull request's session to the service: a comment's run names its comment, and shadow and live sessions are kept apart. */
export interface SessionOf {
  pr: number;
  comment: number;
  shadow: boolean;
}

/** Refused is the service turning a run away, which no session failure may hide. */
class Refused extends Error {}

async function sessionCall(url: string, method: "GET" | "PUT", of: SessionOf, body?: Buffer): Promise<Response> {
  const at = new URL("/session", url);
  at.search = new URLSearchParams({ pr: String(of.pr), comment: String(of.comment), shadow: String(of.shadow) }).toString();
  const res = await fetch(at, { method, headers: { Authorization: `Bearer ${await oidc(new URL(url).origin)}` }, body: body && new Uint8Array(body), signal: AbortSignal.timeout(60_000) });
  if (res.status === 401 || res.status === 403) throw new Refused(`seidroid /session answered ${res.status}: ${((await res.json().catch(() => ({}))) as any).error ?? ""}`);
  return res;
}

/**
 * loadSession unpacks the pull request's kept session into dir and says how it went. The session
 * only carries a review on, so when it cannot be had the run starts cold in an empty dir; only the
 * service refusing the run fails it.
 */
export async function loadSession(url: string, of: SessionOf, dir: string): Promise<SessionState> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const res = await sessionCall(url, "GET", of);
    if (res.status === 404) return "none";
    if (res.status === 501) return "off";
    if (!res.ok) throw new Error(`seidroid /session answered ${res.status}`);
    unpack(Buffer.from(await res.arrayBuffer()), dir);
    return "restored";
  } catch (e) {
    if (e instanceof Refused) throw e;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log(`::warning::could not restore pull request ${of.pr}'s session, so this run starts cold: ${e instanceof Error ? e.message : String(e)}`);
    return "unavailable";
  }
}

/** saveSession keeps dir as the pull request's session for its next run, and only warns when it cannot. */
export async function saveSession(url: string, of: SessionOf, dir: string): Promise<void> {
  try {
    const packed = pack(dir);
    if (packed.length > MAX_SESSION) throw new Error(`it packs to ${packed.length} bytes, over ${MAX_SESSION}`);
    const res = await sessionCall(url, "PUT", of, packed);
    if (!res.ok) throw new Error(`seidroid answered ${res.status}: ${((await res.json().catch(() => ({}))) as any).error ?? ""}`);
  } catch (e) {
    console.log(`::warning::could not keep pull request ${of.pr}'s session: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** review runs the scouts, then the review unless the scouts settle it, and publishes the outcome through the service. */
async function review(o: Record<string, string>): Promise<void> {
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
  const gh = client(process.env.GITHUB_TOKEN!);
  const started = Date.now();
  const pr = Number(o.pr);
  const pull = await pullAt(gh, `/repos/${owner}/${repo}`, pr, o.head);
  const work = path.resolve(o.work);
  const guidelines = guidelinesPath(o["guidelines-file"]);
  if (o["guidelines-file"] && guidelines !== o["guidelines-file"]) console.log(`::warning::guidelines-file ${o["guidelines-file"]} is not a plain repository path; reading REVIEW.md instead`);
  const { diffLines, hasStandards, base } = lay(work, pull, guidelines);
  recordInputs(o.out, work, pull);
  const home = shellHome(o, work);
  process.chdir(work);
  const timeoutMs = Number(o["timeout-seconds"]) * 1000;
  const transcript = keepsTranscripts(o);

  const sessionDir = o["session-dir"] || undefined;
  const of = { pr, comment: Number(o.comment) || 0, shadow: o.shadow !== "false" };
  const session = sessionDir ? await loadSession(o.service, of, sessionDir) : "off";
  const includeNits = pull.labels.some((l: { name: string }) => l.name === o["nitpick-label"]);
  let outcome: unknown;
  // The session is kept even when the review fails, so readings already made carry on.
  try {
    const { readings: scouts, since } = await scout({ models: lines(o["scout-models"]), request: { repo: `${owner}/${repo}`, pr, diffLines }, work, out: o.out, sessionDir, base, head: pull.head.sha, thinking: o.thinking, timeoutMs, transcript });
    // A request with text of its own goes to the review, the only role that reads it, and only readings of this head's whole diff settle one.
    const settled = o.ask || since ? undefined : settleByScouts(scouts, diffLines);
    if (settled) {
      outcome = { submission: settled, settledBy: scouts.map((s) => s.name).join(", ") };
    } else {
      const threads = await earlierFindings(gh, o.service, owner, repo, pr, o.shadow !== "false");
      const request: Request = { repo: `${owner}/${repo}`, pr, diffLines, hasTree: true, hasStandards, hasShell: home !== undefined, includeNits, extraInstructions: o["extra-instructions"] || undefined, ask: o.ask || undefined, scouts, threads };
      const dir = path.join(o.out, "review");
      await run({ role: "review", request, outDir: dir, model: o["review-model"], thinking: o.thinking, timeoutMs, sessionDir, home, transcript });
      const s = submitted(dir);
      outcome = s ? { submission: s } : { failure: `the review did not finish: ${failed(dir)}` };
    }
    if (scanSecrets(JSON.stringify(outcome), held())) outcome = { failure: "the review's answer carried a credential, so it was withheld" };
  } finally {
    if (sessionDir && session !== "off") await saveSession(o.service, of, sessionDir);
  }
  const report = await service(o.service, "/publish", { pr, head: pull.head.sha, outcome, includeNits, shadow: o.shadow !== "false", aiReviewCheck: o["ai-review-check"] === "true", approve: o["approve-on-success"] === "true", guidelines, runs: runsIn(o.out), durationMs: Date.now() - started, session });
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `conclusion=${report.conclusion}\n`);
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
  const pull = await pullAt(gh, base, pr, o.head);
  const { diffLines } = lay(work, pull);
  writeFileSync(path.join(work, QUESTION), await conversation(gh, base, pr, process.env.GITHUB_EVENT_NAME!, comment));
  recordInputs(o.out, work, pull);
  const home = shellHome(o, work);
  process.chdir(work);
  const dir = path.join(o.out, "reply");
  const request = { repo: `${owner}/${repo}`, pr, diffLines, hasShell: home !== undefined, extraInstructions: o["extra-instructions"] || undefined };
  const sessionDir = o["session-dir"] || undefined;
  if (sessionDir) await loadSession(o.service, { pr, comment, shadow: o.shadow !== "false" }, sessionDir);
  await run({ role: "reply", request, outDir: dir, model: o["review-model"], thinking: o.thinking, timeoutMs: Number(o["timeout-seconds"]) * 1000, sessionDir, home, transcript: keepsTranscripts(o) });
  const s = submitted(dir) as ReplySubmission | undefined;
  let body = s ? s.body : `I could not answer this: ${failed(dir)}.`;
  if (scanSecrets(body, held())) body = "My answer carried a credential, so I withheld it.";
  writeFileSync(path.join(dir, "reply.md"), body);
  console.log((await service(o.service, "/reply", { pr, comment, body, runs: runsIn(o.out) })).url);
}

/** react sets the App's reaction on the comment that started the run, and only warns when it cannot; a conclusion other than success or failure clears it. */
async function react(o: Record<string, string>): Promise<void> {
  const state = ["working", "success", "failure"].includes(o.state) ? o.state : "none";
  try {
    await service(o.service, "/react", { pr: Number(o.pr), comment: Number(o.comment), state });
  } catch (e) {
    console.log(`::warning::could not react to comment ${o.comment}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const OPTIONS = [
  "service", "trigger-phrase", "skip-review-label", "re-review-on-push", "allowed-bots",
  "pr", "head", "work", "out", "session-dir", "review-model", "scout-models", "thinking", "timeout-seconds", "nitpick-label", "extra-instructions", "shadow", "comment", "ai-review-check", "state", "home", "prepare", "approve-on-success", "guidelines-file", "ask", "private",
];

async function main(): Promise<void> {
  const { positionals, values: o } = parseArgs({ allowPositionals: true, options: Object.fromEntries(OPTIONS.map((k) => [k, { type: "string" as const, default: "" }])) });
  if (positionals[0] === "review") return review(o);
  if (positionals[0] === "reply") return reply(o);
  if (positionals[0] === "react") return react(o);
  if (positionals[0] !== "guard") throw new Error("usage: job.ts guard|review|reply|react [--option value ...]");
  const ev: Event = { name: process.env.GITHUB_EVENT_NAME!, actor: process.env.GITHUB_ACTOR!, payload: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")) };
  const opts = { phrase: o["trigger-phrase"], skipLabel: o["skip-review-label"], reReviewOnPush: o["re-review-on-push"] === "true", allowedBots: lines(o["allowed-bots"]), shadow: o.shadow !== "false" };
  const gate = await guard(ev, opts, client(process.env.GITHUB_TOKEN!), (pr, comment) => service(o.service, "/allow", { pr, comment }), async (pr) => standingOf(await service(o.service, "/history", { pr })));
  console.log(gate.reason);
  const eof = randomUUID();
  appendFileSync(process.env.GITHUB_OUTPUT!, `run=${gate.run}\nreply=${gate.reply}\npr=${gate.pr}\nhead=${gate.head}\ncomment=${gate.comment}\nask<<${eof}\n${gate.ask}\n${eof}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
