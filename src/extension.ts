import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ScoutSubmission } from "./scout.ts";
import { ReviewSubmission } from "./verdict.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

const SUBMIT = {
  review: {
    name: "submit_review",
    description: "Submit the whole review. Call it once, as your last action; nothing else you write is published.",
    parameters: ReviewSubmission,
  },
  scout: {
    name: "submit_findings",
    description: "Submit your reading. Call it once, as your last action.",
    parameters: ScoutSubmission,
  },
} as const;

/** within resolves p against root and returns its real path, or undefined when that lies outside root or does not exist. */
export function within(root: string, p: string): string | undefined {
  if (p.startsWith("~") || p.startsWith("@")) return undefined;
  try {
    const base = realpathSync(root);
    const real = realpathSync(path.resolve(base, p));
    return real === base || real.startsWith(base + path.sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The seidroid extension gives the model one way to answer, the submit tool named by
 * SEIDROID_SUBMIT, which writes its validated arguments to SEIDROID_OUT and ends the run.
 * Every other tool is refused unless it only reads inside the working directory.
 */
export default function seidroid(pi: ExtensionAPI): void {
  const out = process.env.SEIDROID_OUT;
  const kind = process.env.SEIDROID_SUBMIT;
  if (!out || (kind !== "review" && kind !== "scout")) throw new Error("SEIDROID_OUT and SEIDROID_SUBMIT=review|scout are required");
  const tool = SUBMIT[kind];
  const root = process.cwd();

  pi.on("tool_call", async (event) => {
    if (event.toolName === tool.name) return undefined;
    if (!READ_TOOLS.has(event.toolName)) return { block: true, reason: `${event.toolName} is not available here` };
    const input = event.input as { path?: string };
    const real = within(root, input.path ?? ".");
    if (real === undefined) return { block: true, reason: "only existing files inside the working directory can be read" };
    input.path = real;
    return undefined;
  });

  pi.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id, params) {
      writeFileSync(out, JSON.stringify(params));
      return { content: [{ type: "text", text: "Submitted." }], details: {}, terminate: true };
    },
  });
}
