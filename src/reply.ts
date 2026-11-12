import { Type, type Static } from "typebox";
import { DIFF, INTENT, TREE } from "./prompt.ts";
import { prose } from "./prose.ts";

export const QUESTION = "question.md";
const MAX_EXTRA_INSTRUCTIONS = 4000;

export const ReplySubmission = Type.Object(
  { body: Type.String({ minLength: 1, maxLength: 30_000, description: "The reply, as GitHub markdown." }) },
  { additionalProperties: false },
);
export type ReplySubmission = Static<typeof ReplySubmission>;

export interface ReplyRequest {
  repo: string;
  pr: number;
  diffLines: number;
  extraInstructions?: string;
}

/** replyPrompt asks for one answer to the comment laid out in QUESTION. */
export function replyPrompt(req: ReplyRequest): string {
  const text = (req.extraInstructions ?? "").trim();
  const extra = text ? prose("reply-extra", { text: text.slice(0, MAX_EXTRA_INSTRUCTIONS) }) : "";
  return prose("reply", { repo: req.repo, pr: req.pr, question: QUESTION, diff: DIFF, lines: req.diffLines, tree: TREE, intent: INTENT, extra });
}
