import { all, type GitHub, type Response } from "./github.ts";
import { recordedThreads, recordFindings, type PriorThread } from "./history.ts";
import { partition, type DiffFile } from "./place.ts";
import { checkOutput, findingComment, findingDetail, MARKER, noVerdict, repeatComment, summaryComment, type CheckOutput, type Moved } from "./render.ts";
import { scanSecrets } from "./secrets.ts";
import { buildThreadPlan, placeableFindings, standing, type Finding, type ThreadPlan, type Verdict } from "./verdict.ts";

export interface Target {
  owner: string;
  repo: string;
  pr: number;
  /** The commit the review read. */
  head: string;
  /** The App's login, e.g. seidroid[bot]. */
  bot: string;
  /** The run attempt's URL; it tells this attempt's review from an earlier attempt's. */
  runUrl: string;
  checkName: string;
  includeNits: boolean;
  /** Post only the check run, leaving the pull request's conversation alone. */
  shadow: boolean;
  /** Post the check run a second time as AI Review, the name a branch rule written for v1 requires. */
  aiReviewCheck: boolean;
  /** Approve a clean review; without it a clean review only comments. */
  approve: boolean;
}

export type Outcome = { verdict: Verdict } | { failure: string };

export interface Report {
  conclusion: CheckOutput["conclusion"];
  /** The check run's title. */
  title: string;
  inline: number;
  file: number;
  /** Findings restated in the open thread of this App's that already carries them. */
  replied: number;
  unplaced: number;
  resolved: string[];
  dismissed: number;
  /** The head the pull request had moved to from the commit reviewed; empty when it had not. */
  moved: string;
}

const EVENT = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;
const DISMISSAL = "Superseded: the latest review found nothing blocking in this change.";
const WITHDRAWAL = "Withdrawn: the head moved while this approval was posted, so it does not cover the newer commits.";
/** NEAR is how many lines apart a finding and an open thread on the same side of a file may be and still carry the same finding. */
const NEAR = 3;
const MAX_FILES = 3_000;
const AI_REVIEW = "AI Review";
const MAX_HISTORY_COMMITS = 30;

/** publish posts a review outcome on the pull request as the App, and reports what landed. */
export async function publish(gh: GitHub, t: Target, outcome: Outcome, literals: readonly string[] = []): Promise<Report> {
  const base = `/repos/${t.owner}/${t.repo}`;
  const report: Report = { conclusion: "failure", title: "", inline: 0, file: 0, replied: 0, unplaced: 0, resolved: [], dismissed: 0, moved: "" };
  const secret = "verdict" in outcome ? scanSecrets(JSON.stringify(outcome.verdict), literals) : "";
  if ("failure" in outcome || secret) {
    const nv = noVerdict("failure" in outcome ? outcome.failure : `the review names something shaped like a ${secret}, so none of it was posted`, t.runUrl);
    report.conclusion = nv.check.conclusion;
    report.title = nv.check.title;
    await check(gh, base, t, nv.check);
    if (!t.shadow) {
      await clearNotices(gh, base, t);
      await must(gh.rest("POST", `${base}/issues/${t.pr}/comments`, { body: nv.comment }), "post the no-verdict notice");
    }
    return report;
  }

  const v = outcome.verdict;
  const { decision } = standing(v);
  const own = await ownThreads(gh, t);
  const plan = buildThreadPlan(v, t.includeNits, new Set(own.keys()));
  const findings = placeableFindings(v, t.includeNits, new Set(own.keys()));
  const landed: Finding[] = [];
  const unplaced: Finding[] = [];

  if (t.shadow) {
    unplaced.push(...findings);
  } else {
    const pull = await readPull(gh, base, t);
    report.moved = pull.head.sha === t.head ? "" : pull.head.sha;
    const moved: Moved | undefined = report.moved ? { read: t.head, head: report.moved } : undefined;
    let repeats = new Map<Finding, string>();
    let anchored: Finding[] = [];
    if (moved) {
      // A review of a commit the pull request has moved past leaves the code and its threads alone and never approves.
      unplaced.push(...findings);
    } else {
      repeats = repeatsOf(findings, own, new Set(plan.addressed));
      const placed = partition(findings.filter((f) => !repeats.has(f)), await diffFiles(gh, base, t, pull));
      anchored = placed.anchored;
      for (const [f, id] of repeats) await replyIn(gh, t, id, f, landed, unplaced, report);
      for (const f of [...placed.unknown, ...placed.loose]) await placeAlone(gh, base, t, f, placed.unknown.includes(f), landed, unplaced, report);
    }
    const review = async (comments: Finding[], event: string) => {
      const res = await gh.rest("POST", `${base}/pulls/${t.pr}/reviews`, {
        commit_id: t.head,
        event,
        body: summaryComment(v, t.includeNits, t.runUrl, unplaced, moved),
        comments: comments.map((f) => ({ path: f.file, line: f.line, side: f.side, body: findingComment(f) })),
      });
      return res.status >= 500 || res.status === 0 ? landedAnyway(gh, base, t, res) : res;
    };
    const event = decision === "approve" && (!t.approve || moved) ? "COMMENT" : EVENT[decision];
    let res = await review(anchored, event);
    if (res.status === 200) {
      landed.push(...anchored);
      report.inline += anchored.length;
    } else if (res.status === 422) {
      for (const f of anchored) await placeAlone(gh, base, t, f, true, landed, unplaced, report);
      res = await review([], event);
      if (res.status === 422 && event !== "COMMENT") res = await review([], "COMMENT");
    }
    await must(res, "post the review");
    if (res.data?.state === "APPROVED") report.moved = await withdrawIfMoved(gh, base, t, res.data.id);
    if (!moved) await resolveThreads(gh, plan, own, landed, new Set(repeats.values()), report);
    await clearNotices(gh, base, t);
  }

  const out = { ...checkOutput(v, t.includeNits, unplaced), text: recordFindings(t.pr, placeableFindings(v, t.includeNits, new Set())) };
  report.conclusion = out.conclusion;
  report.title = out.title;
  report.unplaced = unplaced.length;
  await check(gh, base, t, out);
  if (!t.shadow && decision !== "request_changes" && out.conclusion === "success") {
    report.dismissed = await dismissStale(gh, base, t);
  }
  return report;
}

async function must(res: Promise<Response> | Response, what: string): Promise<void> {
  const { status, data } = await res;
  if (status < 200 || status >= 300) throw new Error(`could not ${what}: ${status} ${data?.message ?? ""}`);
}

/** landedAnyway looks for a review an ambiguous failure may still have posted, so a retry never posts it twice. */
async function landedAnyway(gh: GitHub, base: string, t: Target, failed: Response): Promise<Response> {
  const reviews = await all<{ id: number; state: string; commit_id: string; body: string; user: { login: string } }>(gh, `${base}/pulls/${t.pr}/reviews`);
  const mine = reviews.find((r) => r.commit_id === t.head && login(r.user.login) === login(t.bot) && r.body.includes(`](${t.runUrl})`));
  return mine ? { status: 200, data: mine } : failed;
}

interface Pull {
  changed_files: number;
  head: { sha: string };
}

async function readPull(gh: GitHub, base: string, t: Target): Promise<Pull> {
  const pr = await gh.rest<Pull>("GET", `${base}/pulls/${t.pr}`);
  await must(pr, "read the pull request");
  return pr.data;
}

/** diffFiles lists the pull request's files, or none when GitHub's list is cut short, so nothing is anchored on a partial diff. */
async function diffFiles(gh: GitHub, base: string, t: Target, pr: Pull): Promise<DiffFile[]> {
  if (pr.changed_files > MAX_FILES) return [];
  const files = await all<DiffFile>(gh, `${base}/pulls/${t.pr}/files`);
  return files.length === pr.changed_files ? files : [];
}

/**
 * withdrawIfMoved dismisses the approval just posted when the head moved while it was posted, so it
 * never stands for commits the review did not read, and returns the head it moved to.
 */
async function withdrawIfMoved(gh: GitHub, base: string, t: Target, review: number): Promise<string> {
  const { head } = await readPull(gh, base, t);
  if (head.sha === t.head) return "";
  const res = await gh.rest("PUT", `${base}/pulls/${t.pr}/reviews/${review}/dismissals`, { message: WITHDRAWAL, event: "DISMISS" });
  if (res.status !== 200) console.warn(`could not withdraw the approval of ${t.head}: ${res.status} ${res.data?.message ?? ""}`);
  return head.sha;
}

/**
 * repeatsOf pairs each finding with the open thread of this App's that already carries it, one finding
 * to a thread: first a thread on its file with the same detail, then the nearest within NEAR lines on
 * its side. Threads the review says are addressed carry nothing.
 */
function repeatsOf(findings: readonly Finding[], own: ReadonlyMap<string, OwnThread>, addressed: ReadonlySet<string>): Map<Finding, string> {
  const out = new Map<Finding, string>();
  const open = [...own].filter(([id]) => !addressed.has(id));
  const take = (f: Finding, score: (th: OwnThread) => number) => {
    let best: [string, number] | undefined;
    for (const [id, th] of open) {
      const s = th.path === f.file ? score(th) : Infinity;
      if (s < (best?.[1] ?? Infinity)) best = [id, s];
    }
    if (!best) return;
    out.set(f, best[0]);
    open.splice(open.findIndex(([id]) => id === best[0]), 1);
  };
  for (const f of findings) take(f, (th) => (th.detail !== "" && th.detail === f.detail ? 0 : Infinity));
  for (const f of findings) {
    if (out.has(f)) continue;
    take(f, (th) => {
      const gap = th.side === f.side ? Math.min(...[th.line, th.originalLine].map((l) => (l === null ? Infinity : Math.abs(l - f.line)))) : Infinity;
      return gap <= NEAR ? gap : Infinity;
    });
  }
  return out;
}

/** replyIn restates a finding in the thread that carries it; a reply that may not have landed leaves it to the review body. */
async function replyIn(gh: GitHub, t: Target, thread: string, f: Finding, landed: Finding[], unplaced: Finding[], report: Report): Promise<void> {
  try {
    await gh.graphql(`mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }`, { id: thread, body: repeatComment(f, t.head) });
  } catch (e) {
    console.warn(`could not reply in thread ${thread}: ${e instanceof Error ? e.message : String(e)}`);
    unplaced.push(f);
    return;
  }
  landed.push(f);
  report.replied++;
}

/**
 * placeAlone posts one finding on its line when it may have one, else on its file, else leaves it to the review body.
 * Only GitHub's refusal (422) moves on to the next place: any other failure may still have posted the comment.
 */
async function placeAlone(gh: GitHub, base: string, t: Target, f: Finding, tryLine: boolean, landed: Finding[], unplaced: Finding[], report: Report): Promise<void> {
  const path = `${base}/pulls/${t.pr}/comments`;
  const at = { commit_id: t.head, path: f.file };
  const tries: [object, "inline" | "file"][] = [
    ...(tryLine ? [[{ ...at, line: f.line, side: f.side, body: findingComment(f) }, "inline"] as [object, "inline"]] : []),
    [{ ...at, subject_type: "file", body: findingComment(f, true) }, "file"],
  ];
  for (const [body, where] of tries) {
    const { status } = await gh.rest("POST", path, body);
    if (status === 201) {
      landed.push(f);
      report[where]++;
      return;
    }
    if (status !== 422) break;
  }
  unplaced.push(f);
}

const OWN_THREADS = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved path line originalLine diffSide comments(first: 1) { nodes { body author { login } } } }
  } } }
}`;

const login = (s: string): string => s.replace(/\[bot\]$/, "");

/** OwnThread is an open thread this App started with a finding: its first comment and where it sits. */
interface OwnThread {
  body: string;
  detail: string;
  path: string;
  /** On the current head, or null once outdated or on the whole file. */
  line: number | null;
  originalLine: number | null;
  side: Finding["side"];
}

/** ownThreads maps the open threads this App started with a finding to their first comment and place. */
async function ownThreads(gh: GitHub, t: Target): Promise<Map<string, OwnThread>> {
  const own = new Map<string, OwnThread>();
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: any = await gh.graphql(OWN_THREADS, { owner: t.owner, repo: t.repo, pr: t.pr, after });
    const threads = data.repository.pullRequest.reviewThreads;
    for (const th of threads.nodes as { id: string; isResolved: boolean; path: string; line: number | null; originalLine: number | null; diffSide: string; comments: { nodes: { body: string; author: { login: string } | null }[] } }[]) {
      const first = th.comments.nodes[0];
      if (th.isResolved || !first || login(first.author?.login ?? "") !== login(t.bot) || !first.body.startsWith(MARKER.finding)) continue;
      own.set(th.id, { body: first.body, detail: findingDetail(first.body), path: th.path, line: th.line ?? null, originalLine: th.originalLine ?? null, side: th.diffSide === "LEFT" ? "LEFT" : "RIGHT" });
    }
    if (!threads.pageInfo.hasNextPage) break;
    after = threads.pageInfo.endCursor;
  }
  return own;
}

/**
 * resolveThreads resolves the threads the review addressed and those a landed finding restates,
 * with every other open thread of this App's that carries the same finding, but never a thread
 * this review just restated a finding in.
 */
async function resolveThreads(gh: GitHub, plan: ThreadPlan, own: ReadonlyMap<string, OwnThread>, landed: readonly Finding[], kept: ReadonlySet<string>, report: Report): Promise<void> {
  const restated = new Set(landed.flatMap((f) => f.supersedes));
  const named = [...plan.addressed, ...plan.superseded.filter((id) => restated.has(id))];
  const bodies = new Set(named.map((id) => own.get(id)?.body));
  const ids = [...own].filter(([id, th]) => !kept.has(id) && (named.includes(id) || bodies.has(th.body))).map(([id]) => id);
  for (const id of ids) {
    await gh.graphql(`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id });
    report.resolved.push(id);
  }
}

async function check(gh: GitHub, base: string, t: Target, out: CheckOutput): Promise<void> {
  const post = (name: string) =>
    gh.rest("POST", `${base}/check-runs`, {
      name,
      head_sha: t.head,
      status: "completed",
      conclusion: out.conclusion,
      output: { title: out.title, summary: out.summary, text: out.text },
      details_url: t.runUrl,
    });
  await must(post(t.checkName), "post the check run");
  if (!t.aiReviewCheck) return;
  const copy = await post(AI_REVIEW).catch((e: Error) => ({ status: 0, data: { message: e.message } }));
  if (copy.status !== 201) console.warn(`could not post the ${AI_REVIEW} check run: ${copy.status} ${copy.data?.message ?? ""}`);
}

interface CheckRun {
  completed_at: string | null;
  app: { slug: string } | null;
  output: { text: string | null };
}

/**
 * recordedHistory reads back the findings of this App's latest check run named checkName that
 * records any for the pull request, on the newest of its commits that has one.
 */
export async function recordedHistory(gh: GitHub, base: string, pr: number, checkName: string, bot: string): Promise<PriorThread[]> {
  const commits = await all<{ sha: string }>(gh, `${base}/pulls/${pr}/commits`, 3);
  for (const { sha } of commits.slice(-MAX_HISTORY_COMMITS).reverse()) {
    const res = await gh.rest<{ check_runs: CheckRun[] }>("GET", `${base}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100`);
    await must(res, `read the check runs on ${sha}`);
    const runs = res.data.check_runs
      .filter((c) => c.completed_at && login(c.app?.slug ?? "") === login(bot))
      .sort((a, b) => b.completed_at!.localeCompare(a.completed_at!));
    for (const c of runs) {
      const threads = recordedThreads(c.output.text, pr);
      if (threads) return threads;
    }
  }
  return [];
}

/** clearNotices deletes this App's earlier no-verdict notices on the pull request. */
async function clearNotices(gh: GitHub, base: string, t: Target): Promise<void> {
  const comments = await all<{ id: number; body: string; user: { login: string } }>(gh, `${base}/issues/${t.pr}/comments`);
  for (const c of comments) {
    if (login(c.user.login) === login(t.bot) && c.body.startsWith(MARKER.noVerdict)) await gh.rest("DELETE", `${base}/issues/comments/${c.id}`);
  }
}

/** dismissStale dismisses this App's standing change requests once a review of the current head finds nothing blocking. */
async function dismissStale(gh: GitHub, base: string, t: Target): Promise<number> {
  const pr = await gh.rest<{ head: { sha: string } }>("GET", `${base}/pulls/${t.pr}`);
  if (pr.status !== 200 || pr.data.head.sha !== t.head) return 0;
  const reviews = await all<{ id: number; state: string; body: string; user: { login: string } }>(gh, `${base}/pulls/${t.pr}/reviews`);
  let n = 0;
  for (const r of reviews) {
    if (r.state !== "CHANGES_REQUESTED" || login(r.user.login) !== login(t.bot) || !r.body.startsWith(MARKER.verdict)) continue;
    if ((await gh.rest("PUT", `${base}/pulls/${t.pr}/reviews/${r.id}/dismissals`, { message: DISMISSAL, event: "DISMISS" })).status === 200) n++;
  }
  return n;
}
