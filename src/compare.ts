import type { GitHub } from "./github.ts";
import { verdicts, type Metrics, type Verdicts } from "./metrics.ts";

/** Shadowed is a commit v2 reviewed in shadow, waiting for v1's verdict on it. */
export interface Shadowed {
  owner: string;
  repo: string;
  head: string;
  v2: Verdicts;
  /** How long v2's review job took to publish, in seconds, when the job said. */
  v2Seconds?: number;
  /** When v2 published. */
  at: number;
}

export interface CompareConfig {
  /** The check run v1 publishes its verdict as. */
  check: string;
  /** The check run of v1's review job, whose time it took is v1's. */
  job: string;
  /** How long to wait for v1 before counting it missing. */
  waitMs: number;
}

interface CheckRun {
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  app: { slug: string } | null;
  output: { title: string | null };
}

const MAX_WAITING = 1000;

/** comparer pairs each commit v2 reviews in shadow with v1's verdict on the same commit, and records the pair in m. */
export function comparer(m: Metrics, cfg: CompareConfig, deps: { github(owner: string, repo: string): Promise<GitHub>; bot(): Promise<string> }) {
  const waiting = new Map<string, Shadowed>();
  let busy = false;

  const latest = async (gh: GitHub, s: Shadowed, name: string, slug: string): Promise<CheckRun | undefined> => {
    const res = await gh.rest<{ check_runs: CheckRun[] }>("GET", `/repos/${s.owner}/${s.repo}/commits/${s.head}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest`);
    if (res.status !== 200) throw new Error(`could not read ${name} on ${s.head}: ${res.status}`);
    return res.data.check_runs.find((c) => c.app?.slug === slug && c.status === "completed");
  };

  const record = (s: Shadowed, v1: Verdicts | undefined, v1Seconds?: number, v1At?: number) => {
    const repo = `${s.owner}/${s.repo}`;
    m.compared.inc({ repo, v1: v1?.verdict ?? "missing", v2: s.v2.verdict });
    m.comparedFindings.observe({ repo, reviewer: "v2" }, s.v2.findings);
    if (s.v2Seconds !== undefined) m.comparedSeconds.observe({ repo, reviewer: "v2" }, s.v2Seconds);
    if (!v1) return;
    m.comparedFindings.observe({ repo, reviewer: "v1" }, v1.findings);
    if (v1Seconds !== undefined) m.comparedSeconds.observe({ repo, reviewer: "v1" }, v1Seconds);
    if (v1At !== undefined) m.first.inc({ repo, reviewer: v1At <= s.at ? "v1" : "v2" });
  };

  return {
    /** add waits for v1's verdict on a commit v2 reviewed, replacing any earlier wait on the same commit. */
    add(s: Shadowed): void {
      const key = `${s.owner}/${s.repo}@${s.head}`;
      waiting.delete(key);
      if (waiting.size >= MAX_WAITING) waiting.delete(waiting.keys().next().value!);
      waiting.set(key, s);
    },

    /** tick looks for v1's verdict on each waiting commit, recording each it finds and each it has waited for too long. */
    async tick(now = Date.now()): Promise<void> {
      if (busy) return;
      busy = true;
      try {
        await look(now);
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
    for (const [key, s] of waiting) {
      try {
        const gh = await deps.github(s.owner, s.repo);
        const v1 = await latest(gh, s, cfg.check, slug);
        if (!v1) {
          if (now - s.at > cfg.waitMs) {
            waiting.delete(key);
            record(s, undefined);
          }
          continue;
        }
        const job = await latest(gh, s, cfg.job, "github-actions");
        const took = job?.started_at && job.completed_at ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000 : undefined;
        waiting.delete(key);
        record(s, verdicts({ conclusion: v1.conclusion ?? "failure", title: v1.output.title ?? "" }), took, v1.completed_at ? Date.parse(v1.completed_at) : undefined);
      } catch (e) {
        console.log(JSON.stringify({ compare: key, error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }
}
