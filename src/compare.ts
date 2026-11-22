import type { GitHub } from "./github.ts";
import { verdicts, type Metrics } from "./metrics.ts";

export interface CompareConfig {
  /** The check run v1 publishes its verdict as. */
  check: string;
  /** The check run of v1's review job, whose time it took is v1's. */
  job: string;
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
  output: { title: string | null };
}

const MAX_WAITING = 1000;
const RESUMED_PULLS = 100;
const RESUMED_COMMITS = 5;

/**
 * comparer pairs each review v2 publishes in shadow with one of v1's on the same commit, in order of completion,
 * and records the pair in m. Where each v2 review stands is kept in its own check run, so a restart loses nothing
 * but the list of commits to look at, which resume rebuilds from the recently updated pull requests.
 */
export function comparer(m: Metrics, cfg: CompareConfig & { checkName: string }, deps: { github(owner: string, repo: string): Promise<GitHub>; bot(): Promise<string> }) {
  const waiting = new Map<string, { owner: string; repo: string; head: string }>();
  const resuming = new Map<string, { owner: string; repo: string; since: number }>();
  const resumed = new Set<string>();
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

    /** resume, once per repository, looks again at the latest commits of every pull request updated within twice the wait. */
    resume(owner: string, repo: string, now = Date.now()): void {
      const key = `${owner}/${repo}`;
      if (resumed.has(key)) return;
      resumed.add(key);
      resuming.set(key, { owner, repo, since: now - 2 * cfg.waitMs });
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
    for (const [key, r] of resuming) {
      try {
        await rebuild(r);
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

  async function rebuild(r: { owner: string; repo: string; since: number }): Promise<void> {
    const gh = await deps.github(r.owner, r.repo);
    const base = `/repos/${r.owner}/${r.repo}`;
    const res = await gh.rest<{ number: number; updated_at: string; head: { sha: string } }[]>("GET", `${base}/pulls?state=all&sort=updated&direction=desc&per_page=${RESUMED_PULLS}`);
    if (res.status !== 200) throw new Error(`could not read the pull requests: ${res.status}`);
    for (const p of res.data.filter((p) => Date.parse(p.updated_at) >= r.since)) {
      watch(r.owner, r.repo, p.head.sha);
      const commits = await gh.rest<{ sha: string }[]>("GET", `${base}/pulls/${p.number}/commits?per_page=100`);
      if (commits.status !== 200) throw new Error(`could not read the commits of pull request ${p.number}: ${commits.status}`);
      for (const c of commits.data.slice(-RESUMED_COMMITS)) watch(r.owner, r.repo, c.sha);
    }
  }

  /** pair records every v2 review on head it can settle, and reports whether none is left waiting. */
  async function pair(owner: string, repo: string, head: string, slug: string, now: number): Promise<boolean> {
    const gh = await deps.github(owner, repo);
    const runs = async (name: string, app: string) => {
      const res = await gh.rest<{ check_runs: CheckRun[] }>("GET", `/repos/${owner}/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`);
      if (res.status !== 200) throw new Error(`could not read ${name} on ${head}: ${res.status}`);
      return res.data.check_runs.filter((c) => c.app?.slug === app).sort((a, b) => (a.completed_at ?? "~").localeCompare(b.completed_at ?? "~"));
    };
    const v2 = (await runs(cfg.checkName, slug)).filter((c) => c.completed_at && c.external_id?.startsWith(COMPARE));
    const due = v2.filter((c) => c.external_id!.startsWith(pending()));
    if (!due.length) return true;
    const claimed = new Set(v2.map((c) => /^compare:v1:(\d+)$/.exec(c.external_id!)?.[1]).filter(Boolean).map(Number));
    const v1 = (await runs(cfg.check, slug)).filter((c) => c.status === "completed" && c.completed_at && !claimed.has(c.id));
    const jobs = v1.length ? await runs(cfg.job, "github-actions") : [];
    for (const [i, run] of due.entries()) {
      const at = Date.parse(run.completed_at!);
      const late = now - at > cfg.waitMs;
      const theirs = v1[i];
      if (!theirs) {
        if (!late) return false;
        await settle(gh, owner, repo, run, `${COMPARE}missing`);
        record(owner, repo, run);
        continue;
      }
      // v1 publishes its verdict before its job ends, so the job's time waits for the job that published it.
      const job = jobs.filter((j) => j.started_at && j.started_at <= theirs.completed_at!).at(-1);
      if (job && job.status !== "completed" && !late) return false;
      await settle(gh, owner, repo, run, `${COMPARE}v1:${theirs.id}`);
      const took = job?.started_at && job.completed_at ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000 : undefined;
      record(owner, repo, run, theirs, took);
    }
    return true;
  }

  async function settle(gh: GitHub, owner: string, repo: string, run: CheckRun, externalId: string): Promise<void> {
    const res = await gh.rest("PATCH", `/repos/${owner}/${repo}/check-runs/${run.id}`, { external_id: externalId });
    if (res.status !== 200) throw new Error(`could not settle check run ${run.id}: ${res.status}`);
  }

  function record(owner: string, repo: string, run: CheckRun, theirs?: CheckRun, v1Seconds?: number): void {
    const name = `${owner}/${repo}`;
    const v2 = verdicts({ conclusion: run.conclusion ?? "failure", title: run.output.title ?? "" });
    const v2Seconds = Number(/^compare:pending:(\d+(?:\.\d+)?)$/.exec(run.external_id!)?.[1] ?? NaN);
    const v1 = theirs && verdicts({ conclusion: theirs.conclusion ?? "failure", title: theirs.output.title ?? "" });
    m.compared.inc({ repo: name, v1: v1?.verdict ?? "missing", v2: v2.verdict });
    if (!v1) return;
    m.comparedFindings.observe({ repo: name, reviewer: "v1" }, v1.findings);
    m.comparedFindings.observe({ repo: name, reviewer: "v2" }, v2.findings);
    if (v1Seconds !== undefined && !Number.isNaN(v2Seconds)) {
      m.comparedSeconds.observe({ repo: name, reviewer: "v1" }, v1Seconds);
      m.comparedSeconds.observe({ repo: name, reviewer: "v2" }, v2Seconds);
    }
    m.first.inc({ repo: name, reviewer: theirs.completed_at! <= run.completed_at! ? "v1" : "v2" });
  }
}
