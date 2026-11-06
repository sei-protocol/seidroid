import { Type, type Static } from "typebox";
import { DIFF, type ScoutReading } from "./prompt.ts";
import { prose } from "./prose.ts";
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
}

/** scoutPrompt asks one scout for an independent, decision-free reading of the diff. */
export function scoutPrompt(req: ScoutRequest): string {
  return prose("scout", { repo: req.repo, pr: req.pr, diff: DIFF, lines: req.diffLines });
}

/** readingOf turns a scout's submission, or the reason it has none, into what the review is shown. */
export function readingOf(name: string, got: ScoutSubmission | string): ScoutReading {
  if (typeof got === "string") return { name, note: got, read: 0, inert: false, findings: [] };
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
  const who = scouts.map((s) => s.name).join(", ");
  return {
    read: Math.min(...scouts.map((s) => s.read)),
    decision: "approve",
    summary: prose("settled", { scouts: who }),
  };
}
