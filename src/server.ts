import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { App } from "./app.ts";
import { all, type GitHub } from "./github.ts";
import { githubKeys, verifyToken, type Claims } from "./oidc.ts";
import { parseAccepted } from "./accepted.ts";
import { publish, type Outcome } from "./publish.ts";
import { replyBody } from "./render.ts";
import { scanSecrets } from "./secrets.ts";
import { clip, guidelinesPath, oneLine } from "./text.ts";
import { parseSubmission, verdictOf } from "./verdict.ts";

export interface Config {
  /** Organisations whose repositories may publish. */
  owners: string[];
  /** The reusable workflow a token must come from, as owner/repo/path; its commit must be on trunk. */
  workflow: string;
  trunk: string;
  /** The org/team whose members may trigger a review. */
  team: string;
  /** Bot logins that may ask for a review without being on the team. */
  bots: string[];
  checkName: string;
}

export interface Deps {
  verify(token: string): Promise<Claims>;
  github(owner: string, repo: string): Promise<GitHub>;
  bot(): Promise<string>;
  publish: typeof publish;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Pull {
  state: string;
  head: { sha: string; repo: { id: number } | null };
  base: { sha: string; repo: { id: number } };
}

interface Asked {
  id: number;
  user: { login: string };
  issue_url?: string;
  pull_request_url?: string;
  in_reply_to_id?: number;
}

/** ASKED is, per event that can ask seidroid something, where its comment is read and where the answer goes. */
const ASKED: Record<string, { read: (base: string, pr: number, id: number) => string; on: (c: Asked, base: string, pr: number) => boolean; answer: (base: string, pr: number, c: Asked) => string; answers: (base: string, pr: number) => string }> = {
  issue_comment: {
    read: (base, _pr, id) => `${base}/issues/comments/${id}`,
    on: (c, base, pr) => c.issue_url?.endsWith(`${base}/issues/${pr}`) === true,
    answer: (base, pr) => `${base}/issues/${pr}/comments`,
    answers: (base, pr) => `${base}/issues/${pr}/comments`,
  },
  pull_request_review_comment: {
    read: (base, _pr, id) => `${base}/pulls/comments/${id}`,
    on: (c, base, pr) => c.pull_request_url?.endsWith(`${base}/pulls/${pr}`) === true,
    answer: (base, pr, c) => `${base}/pulls/${pr}/comments/${c.in_reply_to_id ?? c.id}/replies`,
    answers: (base, pr) => `${base}/pulls/${pr}/comments`,
  },
  pull_request_review: {
    read: (base, pr, id) => `${base}/pulls/${pr}/reviews/${id}`,
    on: () => true,
    answer: (base, pr) => `${base}/issues/${pr}/comments`,
    answers: (base, pr) => `${base}/issues/${pr}/comments`,
  },
};

/** REACTION is the App's reaction on the comment that started a run: eyes while it works, then the review's conclusion, as v1 leaves it. */
const REACTION: Record<string, string | null> = { working: "eyes", success: "+1", failure: "-1", none: null };
const REACTED_AT: Record<string, string> = { issue_comment: "issues", pull_request_review_comment: "pulls" };

const MAX_REQUEST = 1 << 20;
const SHA = /^[0-9a-f]{40}$/;
const CALLER = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** handler serves the seidroid service: the runner proves which workflow run it is with its OIDC token, and the service acts as the App. */
export function handler(cfg: Config, deps: Deps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const used = new Map<string, number>();
  const counts = new Map<string, number>();

  const authorize = async (req: IncomingMessage): Promise<{ claims: Claims; gh: GitHub; owner: string; repo: string }> => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) throw new HttpError(401, "no token");
    const claims = await deps.verify(token).catch((e: Error) => {
      throw new HttpError(401, e.message);
    });
    if (!cfg.owners.includes(claims.repository_owner)) throw new HttpError(403, `${claims.repository_owner} may not use this service`);
    if (!claims.job_workflow_ref.startsWith(`${cfg.workflow}@`)) throw new HttpError(403, `${claims.job_workflow_ref} is not ${cfg.workflow}`);
    const now = Date.now() / 1000;
    for (const [jti, exp] of used) if (exp < now - 120) used.delete(jti);
    if (used.has(claims.jti)) throw new HttpError(401, "token already used");
    used.set(claims.jti, claims.exp);
    const [owner, repo] = claims.repository.split("/") as [string, string];
    const gh = await deps.github(owner, repo);
    const [wOwner, wRepo] = cfg.workflow.split("/");
    const onTrunk = await gh.rest<{ status: string }>("GET", `/repos/${wOwner}/${wRepo}/compare/${claims.job_workflow_sha}...${cfg.trunk}`);
    if (onTrunk.status !== 200 || !["identical", "ahead"].includes(onTrunk.data.status)) {
      throw new HttpError(403, `${claims.job_workflow_sha} is not on ${wOwner}/${wRepo}@${cfg.trunk}`);
    }
    return { claims, gh, owner, repo };
  };

  const member = async (gh: GitHub, login: string): Promise<boolean> => {
    const [org, slug] = cfg.team.split("/");
    return (await gh.rest<{ state: string }>("GET", `/orgs/${org}/teams/${slug}/memberships/${encodeURIComponent(login)}`)).data?.state === "active";
  };

  /** admits says whether login may ask for a review: an allowed bot or an active member of the team. */
  const admits = async (gh: GitHub, login: string): Promise<boolean> => cfg.bots.includes(login) || (await member(gh, login));

  /** callerOnBase says whether a pull_request run's calling workflow is the same file as on the base of the merge it runs on. */
  const callerOnBase = async (gh: GitHub, claims: Claims, caller: string): Promise<boolean> => {
    const base = `/repos/${claims.repository}`;
    const merge = SHA.test(claims.sha) ? await gh.rest<{ parents?: { sha: string }[] }>("GET", `${base}/commits/${claims.sha}`) : undefined;
    const parent = merge?.status === 200 ? merge.data.parents?.[0]?.sha : undefined;
    if (!parent) return false;
    const blob = async (ref: string) => {
      const r = await gh.rest<{ sha?: string }>("GET", `${base}/contents/${caller.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`);
      return r.status === 200 ? r.data.sha : undefined;
    };
    const [ran, onBase] = await Promise.all([blob(claims.sha), blob(parent)]);
    return ran !== undefined && ran === onBase;
  };

  /** admitted holds a run to the guard's rules: no forks, a push run only on its own pull request and from its base's workflow, and a request only from the team or an allowed bot. */
  const admitted = async (gh: GitHub, claims: Claims, pr: number, pull: Pull): Promise<void> => {
    if (pull.head.repo?.id !== pull.base.repo.id) throw new HttpError(403, `pull request ${pr} comes from a fork`);
    if (claims.event_name === "pull_request") {
      if (claims.ref !== `refs/pull/${pr}/merge`) throw new HttpError(403, `this run is for ${claims.ref}, not pull request ${pr}`);
      const caller = claims.workflow_ref.startsWith(`${claims.repository}/`) ? claims.workflow_ref.slice(claims.repository.length + 1).replace(/@[^@]*$/, "") : "";
      if (!CALLER.test(caller) || !(await callerOnBase(gh, claims, caller))) {
        throw new HttpError(403, `pull request ${pr} changes ${caller || claims.workflow_ref}, the workflow it runs; a team member can ask for its review in a comment`);
      }
    } else if (!(await admits(gh, claims.actor))) {
      throw new HttpError(403, `${claims.actor} is not an active member of ${cfg.team}`);
    }
  };

  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    "GET /healthz": async () => ({ ok: true }),

    "POST /allow": async (req) => {
      const { claims, gh, owner, repo } = await authorize(req);
      const body = await json(req);
      const pr = positive(body.pr, "pr");
      const author = (await must(gh.rest<{ user: { login: string } }>("GET", `/repos/${owner}/${repo}/pulls/${pr}`), "read the pull request")).user.login;
      const actor = await admits(gh, claims.actor);
      if (actor && body.comment !== undefined) {
        const path = `/repos/${owner}/${repo}/issues/comments/${positive(body.comment, "comment")}`;
        const comment = await must(gh.rest<{ user: { login: string } }>("GET", path), "read the comment");
        if (comment.user.login === claims.actor) await gh.rest("POST", `${path}/reactions`, { content: "eyes" });
      }
      return { actor, author: await admits(gh, author) };
    },

    "POST /reply": async (req) => {
      const { claims, gh, owner, repo } = await authorize(req);
      const body = await json(req);
      const pr = positive(body.pr, "pr");
      const id = positive(body.comment, "comment");
      if (typeof body.body !== "string" || body.body.trim() === "") throw new HttpError(400, "body must be the reply");
      const asked = Object.hasOwn(ASKED, claims.event_name) ? ASKED[claims.event_name]! : undefined;
      if (!asked || cfg.bots.includes(claims.actor)) throw new HttpError(403, "only a person's comment is answered");
      const base = `/repos/${owner}/${repo}`;
      const pull = await must(gh.rest<Pull>("GET", `${base}/pulls/${pr}`), "read the pull request");
      if (pull.state !== "open") throw new HttpError(409, `pull request ${pr} is ${pull.state}`);
      await admitted(gh, claims, pr, pull);
      const c = await must(gh.rest<Asked>("GET", asked.read(base, pr, id)), "read the comment");
      if (c.user.login !== claims.actor || !asked.on(c, base, pr)) throw new HttpError(403, `comment ${id} is not ${claims.actor}'s on pull request ${pr}`);
      const runUrl = `https://github.com/${claims.repository}/actions/runs/${claims.run_id}/attempts/${claims.run_attempt}`;
      const text = replyBody(body.body, runUrl);
      if (scanSecrets(text)) throw new HttpError(422, "the reply carries a credential");
      const post = () => gh.rest<{ html_url: string }>("POST", asked.answer(base, pr, c), { body: text });
      const answer = async () => {
        const posted = await post();
        if (posted.status !== 0 && posted.status < 500) return posted;
        // A failed post may still have landed; the run link makes text unique to this run.
        await new Promise((r) => setTimeout(r, 1000));
        const bot = await deps.bot();
        const landed = (await all<{ body?: string; html_url: string; user: { login: string } | null }>(gh, asked.answers(base, pr))).find((a) => a.user?.login === bot && a.body === text);
        return landed ? { status: 201, data: landed } : post();
      };
      return { url: (await must(answer(), "post the reply")).html_url };
    },

    "POST /react": async (req) => {
      const { claims, gh, owner, repo } = await authorize(req);
      const body = await json(req);
      const pr = positive(body.pr, "pr");
      const id = positive(body.comment, "comment");
      if (typeof body.state !== "string" || !Object.hasOwn(REACTION, body.state)) throw new HttpError(400, `state must be one of ${Object.keys(REACTION).join(", ")}`);
      const at = REACTED_AT[claims.event_name];
      if (!at) throw new HttpError(409, `a ${claims.event_name} run has no comment to react to`);
      if (!(await admits(gh, claims.actor))) throw new HttpError(403, `${claims.actor} is not an active member of ${cfg.team}`);
      const base = `/repos/${owner}/${repo}`;
      const asked = ASKED[claims.event_name]!;
      const c = await must(gh.rest<Asked>("GET", asked.read(base, pr, id)), "read the comment");
      if (c.user.login !== claims.actor || !asked.on(c, base, pr)) throw new HttpError(403, `comment ${id} is not ${claims.actor}'s on pull request ${pr}`);
      const path = `${base}/${at}/comments/${id}/reactions`;
      const want = REACTION[body.state]!;
      const bot = await deps.bot();
      const stale = (await all<{ id: number; content: string; user: { login: string } | null }>(gh, path)).filter(
        (r) => r.user?.login === bot && r.content !== want && Object.values(REACTION).includes(r.content),
      );
      if (want) await must(gh.rest("POST", path, { content: want }), "react to the comment");
      for (const r of stale) await gh.rest("DELETE", `${path}/${r.id}`);
      return { reaction: want };
    },

    "POST /publish": async (req) => {
      const { claims, gh, owner, repo } = await authorize(req);
      const body = await json(req);
      const pr = positive(body.pr, "pr");
      if (typeof body.head !== "string" || !SHA.test(body.head)) throw new HttpError(400, "head must be a commit sha");
      const base = `/repos/${owner}/${repo}`;
      const pull = await must(gh.rest<Pull>("GET", `${base}/pulls/${pr}`), "read the pull request");
      if (pull.state !== "open") throw new HttpError(409, `pull request ${pr} is ${pull.state}`);
      await admitted(gh, claims, pr, pull);
      if (pull.head.sha !== body.head) {
        const cmp = await gh.rest<{ status: string }>("GET", `${base}/compare/${body.head}...${pull.head.sha}`);
        if (cmp.data?.status !== "ahead") throw new HttpError(409, `${body.head} is not on pull request ${pr}`);
      }
      const runUrl = `https://github.com/${claims.repository}/actions/runs/${claims.run_id}/attempts/${claims.run_attempt}`;
      const target = { owner, repo, pr, head: body.head, bot: await deps.bot(), runUrl, checkName: cfg.checkName, includeNits: body.includeNits === true, shadow: body.shadow !== false, aiReviewCheck: body.shadow === false && body.aiReviewCheck === true, approve: body.approve === true };
      return deps.publish(gh, target, await outcomeOf(gh, base, pull.base.sha, body.outcome, guidelinesPath(body.guidelines)));
    },
  };

  return async (req, res) => {
    const route = `${req.method} ${(req.url ?? "").split("?")[0]}`;
    if (route === "GET /metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end([...counts].map(([k, n]) => `seidroid_requests_total{${k}} ${n}`).join("\n") + "\n");
      return;
    }
    const started = Date.now();
    let status = 200;
    let out: unknown;
    try {
      const serve = routes[route];
      if (!serve) throw new HttpError(404, "not found");
      out = await serve(req);
    } catch (e) {
      status = e instanceof HttpError ? e.status : 502;
      out = { error: e instanceof Error ? e.message : String(e) };
    }
    const key = `route="${routes[route] ? route : "other"}",code="${status}"`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (route !== "GET /healthz") console.log(JSON.stringify({ route, status, ms: Date.now() - started, ...(status >= 400 ? out as object : {}) }));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  };
}

/** outcomeOf rebuilds the verdict on the service's side: the contract is checked again and Accepted conditions come from the guidelines file at the base commit. */
async function outcomeOf(gh: GitHub, base: string, baseSha: string, raw: any, guidelines: string): Promise<Outcome> {
  if (typeof raw?.failure === "string") return { failure: clip(oneLine(raw.failure), 500) || "the run gave no reason" };
  const parsed = parseSubmission(raw?.submission);
  if (!parsed.ok) return { failure: `the review's submission broke the contract: ${parsed.reason}` };
  const md = await gh.rest<{ content: string }>("GET", `${base}/contents/${guidelines}?ref=${baseSha}`);
  if (md.status !== 200 && md.status !== 404) throw new Error(`could not read ${guidelines}: ${md.status}`);
  const accepted = md.status === 200 ? parseAccepted(Buffer.from(md.data.content, "base64").toString("utf8")) : [];
  const v = verdictOf(parsed.submission, accepted, accepted.length ? `${guidelines}@${baseSha.slice(0, 12)}` : "");
  v.settledBy = typeof raw.settledBy === "string" ? clip(oneLine(raw.settledBy), 80) : "";
  return { verdict: v };
}

async function must<T>(p: Promise<{ status: number; data: T }>, what: string): Promise<T> {
  const { status, data } = await p;
  if (status === 404) throw new HttpError(404, `could not ${what}: not found`);
  if (status < 200 || status > 299) throw new Error(`could not ${what}: ${status}`);
  return data;
}

function positive(n: unknown, name: string): number {
  if (!Number.isSafeInteger(n) || (n as number) <= 0) throw new HttpError(400, `${name} must be a positive integer`);
  return n as number;
}

async function json(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST) throw new HttpError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body !== "object" || body === null) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

if (import.meta.main) {
  const env = (k: string, d?: string) => {
    const v = process.env[k] ?? d;
    if (v === undefined) throw new Error(`${k} is not set`);
    return v;
  };
  const app = new App(env("GITHUB_APP_ID"), readFileSync(env("GITHUB_APP_PRIVATE_KEY_FILE"), "utf8"));
  const keys = githubKeys();
  const cfg: Config = {
    owners: env("SEIDROID_OWNERS", "sei-protocol").split(","),
    workflow: env("SEIDROID_WORKFLOW", "sei-protocol/seidroid/.github/workflows/review.yml"),
    trunk: env("SEIDROID_TRUNK", "main"),
    team: env("SEIDROID_TEAM"),
    bots: env("SEIDROID_BOTS", "").split(",").filter((b) => b !== ""),
    checkName: env("SEIDROID_CHECK_NAME", "Seidroid Review"),
  };
  const audience = env("SEIDROID_AUDIENCE", "seidroid");
  const serve = handler(cfg, { verify: (t) => verifyToken(t, audience, keys), github: (o, r) => app.forRepo(o, r), bot: () => app.bot(), publish });
  createServer((req, res) => void serve(req, res)).listen(Number(env("PORT", "8080")));
}
