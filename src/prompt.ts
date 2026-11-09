import { MAX_DETAIL, MAX_FIELD, historyStep, openThreadsStep, threadUpdateStep, type PriorThread } from "./history.ts";
import { block, prose } from "./prose.ts";
import { clip, oneLine } from "./text.ts";

/** The files the review job lays out in the agent's working directory. */
export const DIFF = "pr.diff";
export const TREE = "tree";
export const STANDARDS = "standards.md";
export const INTENT = "intent.md";

const MAX_EXTRA_INSTRUCTIONS = 4000;
const MAX_SCOUT_FINDINGS = 25;

export interface ScoutFinding {
  severity: string;
  file: string;
  line: number;
  detail: string;
}

/** ScoutReading is one scout's independent reading; a non-empty note means it produced none. */
export interface ScoutReading {
  name: string;
  note: string;
  read: number;
  inert: boolean;
  findings: ScoutFinding[];
}

export interface Request {
  repo: string;
  pr: number;
  diffLines: number;
  hasTree: boolean;
  hasStandards: boolean;
  includeNits: boolean;
  extraInstructions?: string;
  scouts: readonly ScoutReading[];
  threads: readonly PriorThread[];
}

const PATH_BYTES = /^[A-Za-z0-9._\-/+]+$/;

/** pointsSomewhereReal reports whether file is a plain relative path inside the tree. */
export const pointsSomewhereReal = (file: string): boolean =>
  PATH_BYTES.test(file) && !file.startsWith("/") && !file.split("/").includes("..");

/** location names file:line under the tree, or says it names no place in it. */
export function location(file: string, line: number): string {
  const name = clip(oneLine(file), MAX_FIELD);
  if (!pointsSomewhereReal(name)) return "(no place in this tree)";
  const path = `${TREE}/${name.replace(/^\.\//, "")}`;
  return line > 0 ? `${path}:${line}` : path;
}

function readStep(req: Request): string[] {
  const tree = req.hasTree ? prose("tree", { tree: TREE }) : prose("no-tree");
  return block("read", { diff: DIFF, lines: req.diffLines, tree });
}

function repoContextStep(req: Request): string[] {
  return [
    ...(req.hasStandards ? block("standards", { standards: STANDARDS, tree: TREE }) : []),
    ...block("intent", { intent: INTENT }),
  ];
}

function extraInstructionsStep(req: Request): string[] {
  const text = (req.extraInstructions ?? "").trim();
  if (text === "") return [];
  return block("extra", { text: clip(text, MAX_EXTRA_INSTRUCTIONS) });
}

function reconcileStep(req: Request): string[] {
  if (req.scouts.length === 0) return [];
  const readings = req.scouts.flatMap((s) => {
    const name = oneLine(s.name);
    if (s.note !== "") return [`  ${name} — no reading: ${clip(oneLine(s.note), MAX_DETAIL)}`];
    if (s.findings.length === 0) return [`  ${name} — read the diff and found nothing`];
    const shown = s.findings.slice(0, MAX_SCOUT_FINDINGS);
    return [
      `  ${name} — ${s.findings.length} finding(s), ${shown.length} shown:`,
      ...shown.map(
        (f) =>
          `      ${clip(oneLine(f.severity), MAX_FIELD)} ${location(f.file, f.line)} — ${clip(oneLine(f.detail), MAX_DETAIL)}`,
      ),
    ];
  });
  return block("reconcile", { readings: readings.join("\n") });
}

function contractRules(req: Request): string[] {
  return block("contract", { diff: DIFF, nits: prose(req.includeNits ? "nits" : "no-nits") });
}

/** reviewPrompt is the first turn of a pull request's review session. */
export function reviewPrompt(req: Request): string {
  return [
    ...block("review", { repo: req.repo, pr: req.pr }),
    ...readStep(req),
    ...repoContextStep(req),
    ...extraInstructionsStep(req),
    ...historyStep(req.threads, location),
    ...block("checklist"),
    ...reconcileStep(req),
    ...block("report"),
    ...contractRules(req),
  ].join("\n");
}

/** followUpPrompt is a later turn in the same session, after the pull request moved. */
export function followUpPrompt(req: Request): string {
  return [
    ...block("follow-up", { repo: req.repo, pr: req.pr, diff: DIFF, tree: TREE }),
    ...readStep(req),
    ...repoContextStep(req),
    ...extraInstructionsStep(req),
    ...openThreadsStep(req.threads, location),
    ...threadUpdateStep(req.threads, location),
    ...block("follow-up-review"),
    ...reconcileStep(req),
    ...block("follow-up-report"),
    ...contractRules(req),
  ].join("\n");
}
