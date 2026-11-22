import { Type, type Static } from "typebox";
import { DIFF, SINCE, type ScoutFinding, type ScoutReading } from "./prompt.ts";
import { prose } from "./prose.ts";
import { MAX_DETAIL, MAX_FIELD } from "./history.ts";
import { clip, oneLine } from "./text.ts";
import type { ReviewSubmission } from "./verdict.ts";

export const ScoutSubmission = Type.Object(
  {
    read: Type.Integer({ minimum: 0, description: "Line count of the diff you read; 0 if you never got it." }),
    inert: Type.Boolean({
      description:
        "True only when every changed line is a comment no tool reads, documentation prose or whitespace. When in doubt, false.",
    }),
    findings: Type.Array(
      Type.Object(
        {
          file: Type.String({ minLength: 1 }),
          line: Type.Integer({ minimum: 1 }),
          severity: Type.Unsafe<"high" | "medium" | "low">({ type: "string", enum: ["high", "medium", "low"] }),
          detail: Type.String({ minLength: 1, description: "What is wrong and why it matters." }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ScoutSubmission = Static<typeof ScoutSubmission>;

export interface ScoutRequest {
  repo: string;
  pr: number;
  diffLines: number;
  /** since is set when the scout read an earlier head: SINCE's changed lines and what it found then. */
  since?: { lines: number; findings: readonly ScoutFinding[] };
}

const MAX_EARLIER = 25;

/** carriesOn is whether a scout's earlier findings are few enough to list in full for a since-reading. */
export const carriesOn = (findings: readonly ScoutFinding[]): boolean => findings.length <= MAX_EARLIER;

/** earlier lists a scout's previous findings, one line each, for its next reading. */
const earlier = (findings: readonly ScoutFinding[]): string =>
  findings.length === 0
    ? "  (nothing)"
    : findings
        .map((f) => `  ${clip(oneLine(f.severity), MAX_FIELD)} ${clip(oneLine(f.file), MAX_FIELD)}:${f.line} — ${clip(oneLine(f.detail), MAX_DETAIL)}`)
        .join("\n");

/**
 * scoutPrompt asks one scout for an independent, decision-free reading of the diff, or,
 * when it read an earlier head, of what changed since then in the light of the whole diff.
 */
export function scoutPrompt(req: ScoutRequest): string {
  const step = req.since
    ? prose("scout-since", { earlier: earlier(req.since.findings), since: SINCE, sinceLines: req.since.lines, diff: DIFF, lines: req.diffLines })
    : prose("scout-diff", { diff: DIFF, lines: req.diffLines });
  return prose("scout", { repo: req.repo, pr: req.pr, step, counted: req.since ? `${SINCE}'s` : "the diff's" });
}

/** crossCheck is the public label of the scout at position i of n in scout-models; nothing posted names its model. */
export const crossCheck = (i: number, n: number): string =>
  n === 1 ? "the cross-check" : `cross-check ${i < 26 ? String.fromCharCode(65 + i) : i + 1}`;

/** crossChecks names all n scouts together, as they settle a pull request. */
export const crossChecks = (n: number): string => (n === 1 ? "the cross-check" : n === 2 ? "both cross-checks" : `all ${n} cross-checks`);

/**
 * readingOf turns a scout's submission, or the reason it has none, into what the review is shown.
 * The reason stays in run.json: a provider's error can name the model.
 */
export function readingOf(name: string, got: ScoutSubmission | string): ScoutReading {
  if (typeof got === "string") return { name, note: "it did not finish its reading", read: 0, inert: false, findings: [] };
  if (got.read <= 0) return { name, note: "it could not read the diff", read: 0, inert: false, findings: [] };
  return { name, note: "", read: got.read, inert: got.inert, findings: got.findings };
}

/**
 * settleByScouts approves without a review turn when every scout read the whole diff,
 * found nothing and called it inert; otherwise it returns undefined.
 */
export function settleByScouts(scouts: readonly ScoutReading[], diffLines: number): ReviewSubmission | undefined {
  const clean = (s: ScoutReading) => s.note === "" && s.read >= diffLines && s.inert && s.findings.length === 0;
  if (diffLines <= 0 || scouts.length === 0 || !scouts.every(clean)) {
    return undefined;
  }
  return {
    read: Math.min(...scouts.map((s) => s.read)),
    decision: "approve",
    summary: prose("settled", { scouts: crossChecks(scouts.length) }),
  };
}
