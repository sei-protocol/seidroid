import { all, type GitHub, type Response } from "./github.ts";
import { partition, type DiffFile } from "./place.ts";
import { checkOutput, findingComment, MARKER, noVerdict, summaryComment, type CheckOutput } from "./render.ts";
import { scanSecrets } from "./secrets.ts";
import { buildThreadPlan, placeableFindings, standing, type Finding, type Verdict } from "./verdict.ts";

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
}

export type Outcome = { verdict: Verdict } | { failure: string };

export interface Report {
  conclusion: CheckOutput["conclusion"];
  inline: number;
  file: number;
  unplaced: number;
  resolved: string[];
  dismissed: number;
}

const EVENT = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;
const DISMISSAL = "Superseded: the latest review found nothing blocking in this change.";
const MAX_FILES = 3_000;

/** publish posts a review outcome on the pull request as the App, and reports what landed. */
export async function publish(gh: GitHub, t: Target, outcome: Outcome, literals: readonly string[] = []): Promise<Report> {
  const base = `/repos/${t.owner}/${t.repo}`;
  const report: Report = { conclusion: "failure", inline: 0, file: 0, unplaced: 0, resolved: [], dismissed: 0 };
  const secret = "verdict" in outcome ? scanSecrets(JSON.stringify(outcome.verdict), literals) : "";
  if ("failure" in outcome || secret) {
    const nv = noVerdict("failure" in outcome ? outcome.failure : `the review names something shaped like a ${secret}, so none of it was posted`, t.runUrl);
    report.conclusion = nv.check.conclusion;
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
  const findings = placeableFindings(v, t.includeNits, new Set(own.keys()));
  const { anchored, unknown, loose } = partition(findings, await diffFiles(gh, base, t));
  const landed: Finding[] = [];
  const unplaced: Finding[] = [];

  if (t.shadow) {
    unplaced.push(...findings);
  } else {
    for (const f of [...unknown, ...loose]) await placeAlone(gh, base, t, f, unknown.includes(f), landed, unplaced, report);
    const review = async (comments: Finding[], event: string) => {
      const res = await gh.rest("POST", `${base}/pulls/${t.pr}/reviews`, {
        commit_id: t.head,
        event,
        body: summaryComment(v, t.includeNits, t.runUrl, unplaced),
        comments: comments.map((f) => ({ path: f.file, line: f.line, side: f.side, body: findingComment(f) })),
      });
      return res.status >= 500 || res.status === 0 ? landedAnyway(gh, base, t, res) : res;
    };
    let res = await review(anchored, EVENT[decision]);
    if (res.status === 200) {
      landed.push(...anchored);
      report.inline += anchored.length;
    } else if (res.status === 422) {
      for (const f of anchored) await placeAlone(gh, base, t, f, true, landed, unplaced, report);
      res = await review([], EVENT[decision]);
      if (res.status === 422 && decision !== "comment") res = await review([], "COMMENT");
    }
    await must(res, "post the review");
    await resolveThreads(gh, v, t, own, landed, report);
    await clearNotices(gh, base, t);
  }

  const out = checkOutput(v, t.includeNits, unplaced);
  report.conclusion = out.conclusion;
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
  const reviews = await all<{ commit_id: string; body: string; user: { login: string } }>(gh, `${base}/pulls/${t.pr}/reviews`);
  const mine = reviews.some((r) => r.commit_id === t.head && login(r.user.login) === login(t.bot) && r.body.includes(`](${t.runUrl})`));
  return mine ? { status: 200, data: {} } : failed;
}

/** diffFiles lists the pull request's files, or none when GitHub's list is cut short, so nothing is anchored on a partial diff. */
async function diffFiles(gh: GitHub, base: string, t: Target): Promise<DiffFile[]> {
  const pr = await gh.rest<{ changed_files: number }>("GET", `${base}/pulls/${t.pr}`);
  await must(pr, "read the pull request");
  if (pr.data.changed_files > MAX_FILES) return [];
  const files = await all<DiffFile>(gh, `${base}/pulls/${t.pr}/files`);
  return files.length === pr.data.changed_files ? files : [];
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
    nodes { id isResolved comments(first: 1) { nodes { body author { login } } } }
  } } }
}`;

const login = (s: string): string => s.replace(/\[bot\]$/, "");

/** ownThreads maps the open threads this App started with a finding to their first comment's body. */
async function ownThreads(gh: GitHub, t: Target): Promise<Map<string, string>> {
  const own = new Map<string, string>();
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: any = await gh.graphql(OWN_THREADS, { owner: t.owner, repo: t.repo, pr: t.pr, after });
    const threads = data.repository.pullRequest.reviewThreads;
    for (const th of threads.nodes as { id: string; isResolved: boolean; comments: { nodes: { body: string; author: { login: string } | null }[] } }[]) {
      const first = th.comments.nodes[0];
      if (!th.isResolved && first && login(first.author?.login ?? "") === login(t.bot) && first.body.startsWith(MARKER.finding)) own.set(th.id, first.body);
    }
    if (!threads.pageInfo.hasNextPage) break;
    after = threads.pageInfo.endCursor;
  }
  return own;
}

/**
 * resolveThreads resolves the threads the review addressed and those a landed finding restates,
 * with every other open thread of this App's that carries the same finding.
 */
async function resolveThreads(gh: GitHub, v: Verdict, t: Target, own: Map<string, string>, landed: readonly Finding[], report: Report): Promise<void> {
  const plan = buildThreadPlan(v, t.includeNits, new Set(own.keys()));
  const restated = new Set(landed.flatMap((f) => f.supersedes));
  const named = [...plan.addressed, ...plan.superseded.filter((id) => restated.has(id))];
  const bodies = new Set(named.map((id) => own.get(id)));
  const ids = [...own].filter(([id, body]) => named.includes(id) || bodies.has(body)).map(([id]) => id);
  for (const id of ids) {
    await gh.graphql(`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id });
    report.resolved.push(id);
  }
}

async function check(gh: GitHub, base: string, t: Target, out: CheckOutput): Promise<void> {
  await must(
    gh.rest("POST", `${base}/check-runs`, {
      name: t.checkName,
      head_sha: t.head,
      status: "completed",
      conclusion: out.conclusion,
      output: { title: out.title, summary: out.summary },
      details_url: t.runUrl,
    }),
    "post the check run",
  );
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
