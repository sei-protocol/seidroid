import { clip, byteLength, oneLine } from "./text.ts";
import {
  blockers,
  dedupeKey,
  nonBlockers,
  placeableFindings,
  preExisting,
  reportedBySeverity,
  reportedFindings,
  standing,
  type Conclusion,
  type Finding,
  type Verdict,
} from "./verdict.ts";

export const MARKER = {
  verdict: "<!-- seidroid-review -->",
  finding: "<!-- seidroid-review:finding -->",
  noVerdict: "<!-- seidroid-review:no-verdict -->",
  reply: "<!-- seidroid-reply -->",
} as const;

const MAX_BODY = 60_000;
const MAX_PROSE = 4_000;
const MAX_SECTION = 16_000;
const MAX_ENTRIES = 50;
const MAX_BULLET = 2_000;
const MAX_NAMED = 3;
const MAX_NAMED_TEXT = 400;

/** defuse keeps model text from opening Markdown blocks or HTML of its own, so it renders as the prose it is. */
export function defuse(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(defuseLine)
    .join("\n")
    .replace(/(\\*)<(?=[A-Za-z/!?])/g, (m, bs: string) => (bs.length % 2 === 0 ? `${bs}\\<` : m));
}

function defuseLine(line: string): string {
  const indent = /^[ \t]*/.exec(line)![0];
  const rest = line.slice(indent.length);
  const ordered = /^\d{1,9}(?=[.)](?:[ \t]|$))/.exec(rest);
  if (ordered) return indent + ordered[0] + "\\" + rest.slice(ordered[0].length);
  const block = /^(?:[#>|]|`{3}|~{3}|[-+*](?:[ \t]|$)|([-_*])(?:[ \t]*\1){2}[ \t]*$|=+[ \t]*$)/;
  return block.test(rest) ? indent + "\\" + rest : line;
}

const inline = (s: string, max: number): string => defuse(clip(oneLine(s), max));
const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const located = (f: Finding): string => `${code(`${f.file}:${f.line}`)} — ${inline(f.detail, MAX_BULLET)}`;

function joinNamed(items: readonly string[]): string {
  const named = items.slice(0, MAX_NAMED).map((s) => inline(s, MAX_NAMED_TEXT));
  const more = items.length - named.length;
  return named.join("; ") + (more > 0 ? `; and ${more} more` : "");
}

/** section renders a bold heading, an optional lead and bullets, within the entry and byte caps. */
function section(heading: string, items: readonly string[], lead = ""): string {
  if (items.length === 0 && lead === "") return "";
  const out = [`**${heading}**`, ...(lead ? [lead] : [])].join("\n\n") + (items.length ? "\n" : "");
  let body = "";
  let shown = 0;
  for (const item of items) {
    const bullet = `\n- ${item}`;
    if (shown >= MAX_ENTRIES || byteLength(body + bullet) > MAX_SECTION) break;
    body += bullet;
    shown++;
  }
  const hidden = items.length - shown;
  return out + body + (hidden > 0 ? `\n- _and ${hidden} more, in the workflow run's review artifact._` : "");
}

function positionNote(v: Verdict): string {
  if (v.settledBy) return "";
  const said = code(v.submission.decision);
  switch (standing(v).why) {
    case "blocker": {
      const named = [...blockers(v), ...reportedFindings(v).filter((f) => f.severity === "blocker").map((f) => f.detail)];
      return `**Changes requested.** The review wrote ${said} but names something blocking, and the block decides: ${joinNamed(named)}.`;
    }
    case "empty-comment":
      return "**No position recorded.** The review wrote `comment` with nothing written down, which is how a review that could not read the change reports.";
    case "unread-diff":
      return `**Approval withheld.** The review did not report reading the diff (read: ${v.submission.read}), so a clean result cannot be told from a review of nothing.`;
    case "pre-existing":
      return `**Approval withheld.** The change itself is clean, but a pre-existing blocker stands that ${acceptedSource(v)} does not accept.`;
    default:
      return "";
  }
}

const acceptedSource = (v: Verdict): string => (v.acceptedFrom ? `${code(v.acceptedFrom)}'s review standards` : "the base branch's review standards");

function preExistingSection(v: Verdict): string {
  const items = preExisting(v).map((i) =>
    i.accepted
      ? `**Accepted pre-existing blocker** — listed under Accepted in ${acceptedSource(v)} (${inline(i.accepted, MAX_NAMED_TEXT)}): ${inline(i.body, MAX_BULLET)}`
      : `**${i.severity}** — ${inline(i.body, MAX_BULLET)}`,
  );
  return section("Pre-existing", items, items.length ? "_Already true on the base branch, not introduced here._" : "");
}

function nitSection(v: Verdict, includeNits: boolean): string {
  const nits = includeNits ? [] : reportedFindings(v).filter((f) => f.severity === "nit" && f.detail !== "");
  if (nits.length === 0) return "";
  return `<details><summary>${plural(nits.length, "nit")}, not posted on the code</summary>\n\n${section("Nits", nits.map(located))}\n\n</details>`;
}

/** reviewBody renders the verdict's prose: the summary, the position taken and every finding that is not an inline comment. */
export function reviewBody(v: Verdict, includeNits: boolean, unplaced: readonly Finding[] = []): string {
  const placeable = placeableFindings(v, includeNits, new Set());
  const placed = new Set(placeable.map(dedupeKey));
  const missed = new Set(unplaced.map(dedupeKey));
  const shown = (f: Finding) => f.detail !== "" && (includeNits || f.severity !== "nit");
  const off = [...reportedFindings(v).filter((f) => !placed.has(dedupeKey(f))), ...unplaced].filter(shown);
  const inlineBlockers = placeable.filter((f) => f.severity === "blocker" && !missed.has(dedupeKey(f))).length;
  return [
    inline(v.submission.summary, MAX_PROSE),
    positionNote(v),
    section(
      "Blocking",
      [...blockers(v).map((b) => inline(b, MAX_BULLET)), ...off.filter((f) => f.severity === "blocker").map(located)],
      inlineBlockers ? `_${plural(inlineBlockers, "blocking finding")} on the changed lines, as inline comments._` : "",
    ),
    section("Non-blocking", [
      ...nonBlockers(v).map((b) => inline(b, MAX_BULLET)),
      ...off.filter((f) => f.severity !== "blocker").map(located),
    ]),
    preExistingSection(v),
    nitSection(v, includeNits),
  ]
    .filter((s) => s !== "")
    .join("\n\n");
}

/** fit cuts a body to GitHub's comment size, saying so. */
export function fit(body: string, max = MAX_BODY): string {
  const notice = "\n\n_Cut to fit; the workflow run's review artifact has all of it._";
  return byteLength(body) <= max ? body : clip(body, max - byteLength(notice + "…")) + notice;
}

/** summaryComment is the review's body as posted: marker, prose, and how the review was decided. */
export function summaryComment(v: Verdict, includeNits: boolean, runUrl: string, unplaced: readonly Finding[] = [], moved?: Moved, unapproved?: Unapproved): string {
  const how = v.settledBy ? `settled by ${v.settledBy} with no review turn` : `the review wrote ${code(v.submission.decision)}`;
  const note = moved ? `${movedNote(moved)}\n\n` : unapproved ? `${UNAPPROVED[unapproved]}\n\n` : "";
  return `${MARKER.verdict}\n${fit(note + reviewBody(v, includeNits, unplaced))}\n\n<sub>Seidroid Review · ${how} · [run](${runUrl})</sub>`;
}

/** Moved names the commit a review read and the head the pull request had moved to by the time it was posted. */
export interface Moved {
  read: string;
  head: string;
}

const movedNote = (m: Moved): string =>
  `**The head moved during this review.** It read ${code(m.read.slice(0, 12))}, but the pull request is now at ${code(m.head.slice(0, 12))}, which it has not read, so it lists any findings here rather than on the code and records no approval.`;

/** Unapproved is why a clean review that asked to approve posts as a comment: who asked for it, or the commits it covers. */
export type Unapproved = "requester" | "commits";

const UNAPPROVED: Record<Unapproved, string> = {
  requester: "**Posted as a comment.** Only a review of a team member's pull request, or one a team member asks for, records an approval here.",
  commits: "**Posted as a comment.** This review could not confirm that every commit since its last approval here carries a signature GitHub verified, committed by a team member, so it records no approval.",
};

/** findingComment is an inline finding's body; cited marks one that fell back to the whole file. */
export function findingComment(f: Finding, cited = false): string {
  const where = cited ? `\n\n_Cited at ${code(`${f.file}:${f.line}`)}, outside this diff's changed lines._` : "";
  return fit(`${MARKER.finding}\n**${f.severity}** — ${f.detail}${where}`);
}

const CITED = /\n\n_Cited at `[^`]*`, outside this diff's changed lines\._$/;

/** findingDetail is the severity and detail a finding comment carries, as findingComment wrote them; empty for any other body. */
export function findingDetail(body: string): { severity: string; detail: string } {
  const head = `${MARKER.finding}\n`;
  const m = body.startsWith(head) ? /^\*\*(blocker|suggestion|nit)\*\* — ([\s\S]*)$/.exec(body.slice(head.length)) : null;
  return m ? { severity: m[1]!, detail: m[2]!.replace(CITED, "") } : { severity: "", detail: "" };
}

/** repeatComment is a reply restating a finding in the thread that already carries it, for the review of head. */
export const repeatComment = (f: Finding, head: string): string =>
  fit(`**${f.severity}** — ${f.detail}\n\n_The review of ${code(head.slice(0, 12))} finds this again at ${code(`${f.file}:${f.line}`)}._`);

export interface CheckOutput {
  conclusion: Conclusion;
  title: string;
  summary: string;
  /** text records the findings for the next review to read back. */
  text?: string;
}

/** checkOutput is the check run a verdict concludes. */
export function checkOutput(v: Verdict, includeNits: boolean, unplaced: readonly Finding[] = []): CheckOutput {
  const { blocking, other } = reportedBySeverity(v, includeNits);
  const findings = blocking + other + blockers(v).length + nonBlockers(v).length;
  const pre = preExisting(v).length;
  return {
    conclusion: standing(v).conclusion,
    title: plural(findings, "finding") + (pre ? `, ${pre} pre-existing` : ""),
    summary: fit(reviewBody(v, includeNits, unplaced)),
  };
}

/** noVerdict is what a run that reached no verdict posts and concludes. */
export function noVerdict(reason: string, runUrl: string): { comment: string; check: CheckOutput } {
  const why = inline(reason, MAX_NAMED_TEXT);
  return {
    comment: `${MARKER.noVerdict}\n**This review did not complete.** It reached no verdict, so it took no position: ${why}.\n\n[The run](${runUrl}) has the details.`,
    check: { conclusion: "failure", title: "No verdict", summary: why },
  };
}

/** replyBody is an answer to a comment, posted as is. */
export const replyBody = (text: string, runUrl: string): string => `${MARKER.reply}\n${fit(text)}\n\n<sub>seidroid v2 · [run](${runUrl})</sub>`;
