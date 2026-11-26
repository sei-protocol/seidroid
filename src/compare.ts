import { all, type GitHub } from "./github.ts";
import { verdicts, type Metrics } from "./metrics.ts";

export interface CompareConfig {
  /** The check run v1 publishes its verdict as. */
  check: string;
  /** The check run of v1's review job, whose time it took is v1's. */
  job: string;
  /** The check run of v1's guard job, whose notice says when v1 declined to review a commit again. */
  guard: string;
  /** How long to wait for v1 before counting it missing. */
  waitMs: number;
}

/** The external_id prefix of every check run v2 publishes in shadow, which records where its comparison with v1 stands. */
const COMPARE = "compare:";

/** pending is the external_id of a shadow check run still waiting for v1, with how long v2's review job took when it said. */
export function pending(v2Seconds?: number): string {
  return `${COMPARE}pending${v2Seconds === undefined ? "" : `:${v2Seconds}`}`;
}

interface CheckRun {
  id: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  external_id?: string | null;
  app: { slug: string } | null;
  output: { title: string | null; summary: string | null; text: string | null };
}

/**
 * settlement is the update that settles a v2 check run under externalId. An update that leaves out the output drops
 * its text, which holds the findings /history reads the review back from, so a run with text sends its output back.
 */
export function settlement(run: Pick<CheckRun, "output">, externalId: string): object {
  const { title, summary, text } = run.output;
  return text ? { external_id: externalId, output: { title, summary, text } } : { external_id: externalId };
}

/** The notice v1's guard leaves when a pull request already carries its verdict and a push does not earn another. */
const NOT_REREVIEWED = /already carries a verdict from this workflow, and this \S+ event does not earn another/;

const MAX_WAITING = 1000;
const RESUMED_PULLS = 100;
const RESUMED_COMMITS = 5;
const PULL_COMMIT_PAGES = 3;

/**
 * align pairs the v2 and v1 reviews of one commit, each sorted by completion, without crossing pairs and only within
 * waitMs of each other, so that the total time between partners plus waitMs for each review left unpaired is least.
 * It returns each v2 review's partner, earlier v2 reviews winning ties.
 */
function align<T extends { completed_at: string | null }>(v2: T[], v1: T[], waitMs: number): (T | undefined)[] {
  const apart = (i: number, j: number) => Math.abs(Date.parse(v1[j]!.completed_at!) - Date.parse(v2[i]!.completed_at!));
  // cost[i][j] is the least cost of aligning v2 from i and v1 from j.
  const cost = Array.from({ length: v2.length + 1 }, (_, i) => Array.from({ length: v1.length + 1 }, (_, j) => (v2.length - i + v1.length - j) * waitMs));
  for (let i = v2.length - 1; i >= 0; i--) {
    for (let j = v1.length - 1; j >= 0; j--) {
      const skip = waitMs + Math.min(cost[i + 1]![j]!, cost[i]![j + 1]!);
      cost[i]![j] = apart(i, j) <= waitMs ? Math.min(apart(i, j) + cost[i + 1]![j + 1]!, skip) : skip;
    }
  }
  const out: (T | undefined)[] = [];
  for (let i = 0, j = 0; i < v2.length; ) {
    if (j < v1.length && apart(i, j) <= waitMs && apart(i, j) + cost[i + 1]![j + 1]! === cost[i]![j]) out[i++] = v1[j++];
    else if (j < v1.length && waitMs + cost[i]![j + 1]! === cost[i]![j]) j++;
    else out[i++] = undefined;
  }
  return out;
}

/**
 * comparer pairs each review v2 publishes in shadow with one of v1's on the same commit, in order of completion,
 * and records the pair in m. Where each v2 review stands is kept in its own check run, so a restart loses nothing
 * but the list of commits to look at, which the first tick rebuilds from the recently updated pull requests of every
 * repository deps.repos lists.
 */
export function comparer(m: Metrics, cfg: CompareConfig & { checkName: string }, deps: { github(owner: string, repo: string): Promise<GitHub>; bot(): Promise<string>; repos?(): Promise<{ owner: string; repo: string }[]> }) {
  const waiting = new Map<string, { owner: string; repo: string; head: string }>();
  const resuming = new Map<string, { owner: string; repo: string; since: number }>();
  let listed = !deps.repos;
  let busy = false;

  const watch = (owner: string, repo: string, head: string) => {
    const key = `${owner}/${repo}@${head}`;
    if (waiting.has(key)) return;
    if (waiting.size >= MAX_WAITING) waiting.delete(waiting.keys().next().value!);
    waiting.set(key, { owner, repo, head });
  };

  return {
    /** add looks for v1's verdict on a commit v2 just reviewed in shadow. */
    add(owner: string, repo: string, head: string): void {
      watch(owner, repo, head);
    },

    /** tick pairs each waiting v2 review with v1's, recording each pair it finds and each v2 review it has waited for too long. */
    async tick(now = Date.now()): Promise<void> {
      if (busy) return;
      busy = true;
      try {
        await look(now);
      } catch (e) {
        console.log(JSON.stringify({ compare: "tick", error: e instanceof Error ? e.message : String(e) }));
      } finally {
        busy = false;
      }
    },

    get waiting(): number {
      return waiting.size;
    },
  };

  async function look(now: number): Promise<void> {
    const slug = (await deps.bot()).replace(/\[bot\]$/, "");
    if (!listed) {
      try {
        for (const { owner, repo } of await deps.repos!()) resuming.set(`${owner}/${repo}`, { owner, repo, since: now - 2 * cfg.waitMs });
        listed = true;
      } catch (e) {
        console.log(JSON.stringify({ compare: "repos", error: e instanceof Error ? e.message : String(e) }));
      }
    }
    for (const [key, r] of resuming) {
      try {
        await rebuild(r, slug);
        resuming.delete(key);
      } catch (e) {
        console.log(JSON.stringify({ compare: key, error: e instanceof Error ? e.message : String(e) }));
      }
    }
    for (const [key, c] of waiting) {
      try {
        if (await pair(c.owner, c.repo, c.head, slug, now)) waiting.delete(key);
      } catch (e) {
        console.log(JSON.stringify({ compare: key, error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }

  /** rebuild watches each recent commit of r's recently updated pull requests that still has a v2 review waiting for v1. */
  async function rebuild(r: { owner: string; repo: string; since: number }, slug: string): Promise<void> {
    const gh = await deps.github(r.owner, r.repo);
    const base = `/repos/${r.owner}/${r.repo}`;
    const res = await gh.rest<{ number: number; updated_at: string; head: { sha: string } }[]>("GET", `${base}/pulls?state=all&sort=updated&direction=desc&per_page=${RESUMED_PULLS}`);
    if (res.status !== 200) throw new Error(`could not read the pull requests: ${res.status}`);
    const recent = new Set<string>();
    for (const p of res.data.filter((p) => Date.parse(p.updated_at) >= r.since)) {
      recent.add(p.head.sha);
      // GitHub lists a pull request's commits oldest first, up to 250.
      const commits = await all<{ sha: string }>(gh, `${base}/pulls/${p.number}/commits`, PULL_COMMIT_PAGES);
      for (const c of commits.slice(-RESUMED_COMMITS)) recent.add(c.sha);
    }
    // Only commits still waiting are watched, so the cap on waiting never evicts one in favour of a settled commit.
    for (const head of recent) {
      if ((await shadowRuns(gh, r.owner, r.repo, head, slug)).some((c) => c.external_id!.startsWith(pending()))) watch(r.owner, r.repo, head);
    }
  }

  /** shadowRuns lists the completed check runs v2 published in shadow on head. */
  async function shadowRuns(gh: GitHub, owner: string, repo: string, head: string, slug: string): Promise<CheckRun[]> {
    return (await checkRuns(gh, owner, repo, head, cfg.checkName, slug, "completed_at")).filter((c) => c.completed_at && c.external_id?.startsWith(COMPARE));
  }

  /** checkRuns lists app's check runs named name on head, oldest first by the time by, with missing times last. */
  async function checkRuns(gh: GitHub, owner: string, repo: string, head: string, name: string, app: string, by: "started_at" | "completed_at"): Promise<CheckRun[]> {
    const time = (t: string | null) => (t ? Date.parse(t) : Infinity);
    const res = await gh.rest<{ check_runs: CheckRun[] }>("GET", `/repos/${owner}/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`);
    if (res.status !== 200) throw new Error(`could not read ${name} on ${head}: ${res.status}`);
    return res.data.check_runs.filter((c) => c.app?.slug === app).sort((a, b) => time(a[by]) - time(b[by]));
  }

  /** pair records every v2 review on head it can settle, and reports whether none is left waiting. */
  async function pair(owner: string, repo: string, head: string, slug: string, now: number): Promise<boolean> {
    const gh = await deps.github(owner, repo);
    const runs = (name: string, app: string, by: "started_at" | "completed_at") => checkRuns(gh, owner, repo, head, name, app, by);
    const v2 = await shadowRuns(gh, owner, repo, head, slug);
    const due = v2.filter((c) => c.external_id!.startsWith(pending()));
    if (!due.length) return true;
    const claimed = new Set(v2.map((c) => /^compare:v1:(\d+)$/.exec(c.external_id!)?.[1]).filter(Boolean).map(Number));
    const theirs = (await runs(cfg.check, slug, "completed_at")).filter((c) => c.status === "completed" && c.completed_at);
    // Pairs never cross, so a v1 review completed before the last one already paired is left unpaired.
    const after = Math.max(-Infinity, ...theirs.filter((c) => claimed.has(c.id)).map((c) => Date.parse(c.completed_at!)));
    const v1 = theirs.filter((c) => !claimed.has(c.id) && Date.parse(c.completed_at!) > after);
    const jobs = v1.length ? await runs(cfg.job, "github-actions", "started_at") : [];
    const partners = align(due, v1, cfg.waitMs);
    let absent: Promise<"missing" | "not_rereviewed"> | undefined;
    // Each review is settled in order of completion, so one still waiting for v1 holds back the later ones, whose
    // partners may yet change.
    for (const [k, run] of due.entries()) {
      const late = now - Date.parse(run.completed_at!) > cfg.waitMs;
      const partner = partners[k];
      if (!partner) {
        if (!late) return false;
        // v1 reviewing nothing on this commit because it already left a verdict on an earlier one is no miss of v1's.
        absent ??= theirs.length ? Promise.resolve("missing") : declined(gh, owner, repo, head).then((d) => (d ? "not_rereviewed" : "missing"));
        const v1 = await absent;
        await settle(gh, owner, repo, run, `${COMPARE}${v1}`);
        record(owner, repo, run, v1);
        continue;
      }
      // v1 publishes its verdict before its job ends, so the job's time waits for the job that published it.
      const job = jobs.filter((j) => j.started_at && j.started_at <= partner.completed_at!).at(-1);
      if (job && job.status !== "completed" && !late) return false;
      await settle(gh, owner, repo, run, `${COMPARE}v1:${partner.id}`);
      const took = job?.started_at && job.completed_at ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000 : undefined;
      record(owner, repo, run, partner, took);
    }
    return true;
  }

  /** declined reports whether every guard job of v1's on head said it would not review head because of an earlier verdict. */
  async function declined(gh: GitHub, owner: string, repo: string, head: string): Promise<boolean> {
    const guards = await checkRuns(gh, owner, repo, head, cfg.guard, "github-actions", "started_at");
    for (const guard of guards) {
      const res = await gh.rest<{ annotation_level: string; message: string }[]>("GET", `/repos/${owner}/${repo}/check-runs/${guard.id}/annotations?per_page=100`);
      if (res.status !== 200) throw new Error(`could not read the annotations of check run ${guard.id}: ${res.status}`);
      // A guard run that did not decline may have let a review start that then left no verdict, which is a miss.
      if (!res.data.some((a) => a.annotation_level === "notice" && NOT_REREVIEWED.test(a.message))) return false;
    }
    return guards.length > 0;
  }

  async function settle(gh: GitHub, owner: string, repo: string, run: CheckRun, externalId: string): Promise<void> {
    const res = await gh.rest("PATCH", `/repos/${owner}/${repo}/check-runs/${run.id}`, settlement(run, externalId));
    if (res.status !== 200) throw new Error(`could not settle check run ${run.id}: ${res.status}`);
  }

  function record(owner: string, repo: string, run: CheckRun, theirs: CheckRun | "missing" | "not_rereviewed", v1Seconds?: number): void {
    const name = `${owner}/${repo}`;
    const v2 = verdicts({ conclusion: run.conclusion ?? "failure", title: run.output.title ?? "" });
    const v2Seconds = Number(/^compare:pending:(\d+(?:\.\d+)?)$/.exec(run.external_id!)?.[1] ?? NaN);
    if (typeof theirs === "string") {
      m.compared.inc({ repo: name, v1: theirs, v2: v2.verdict });
      return;
    }
    const v1 = verdicts({ conclusion: theirs.conclusion ?? "failure", title: theirs.output.title ?? "" });
    m.compared.inc({ repo: name, v1: v1.verdict, v2: v2.verdict });
    m.comparedFindings.observe({ repo: name, reviewer: "v1" }, v1.findings);
    m.comparedFindings.observe({ repo: name, reviewer: "v2" }, v2.findings);
    if (v1Seconds !== undefined && !Number.isNaN(v2Seconds)) {
      m.comparedSeconds.observe({ repo: name, reviewer: "v1" }, v1Seconds);
      m.comparedSeconds.observe({ repo: name, reviewer: "v2" }, v2Seconds);
    }
    m.first.inc({ repo: name, reviewer: theirs.completed_at! <= run.completed_at! ? "v1" : "v2" });
  }
}
