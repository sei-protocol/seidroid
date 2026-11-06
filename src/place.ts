import type { Finding } from "./verdict.ts";

export interface DiffFile {
  filename: string;
  /** Absent when GitHub sends no patch, as for a binary or very large file. */
  patch?: string;
}

export interface Placement {
  /** On a line the diff shows, so they go in one review. */
  anchored: Finding[];
  /** In a file the diff names but sends no patch for, so GitHub alone can say whether the line takes a comment. */
  unknown: Finding[];
  /** Outside the diff's lines, so at most they reach the file. */
  loose: Finding[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** commentable returns the lines of each side a review comment can anchor to in one file's patch. */
export function commentable(patch: string): Record<Finding["side"], Set<number>> {
  const lines = { RIGHT: new Set<number>(), LEFT: new Set<number>() };
  let left = 0;
  let right = 0;
  for (const l of patch.split("\n")) {
    const h = HUNK.exec(l);
    if (h) {
      left = Number(h[1]);
      right = Number(h[2]);
    } else if (l.startsWith("+")) {
      lines.RIGHT.add(right++);
    } else if (l.startsWith("-")) {
      lines.LEFT.add(left++);
    } else if (l.startsWith(" ")) {
      lines.RIGHT.add(right++);
      lines.LEFT.add(left++);
    }
  }
  return lines;
}

/** partition sorts findings by where they can land in the diff GitHub has for the pull request. */
export function partition(findings: readonly Finding[], files: readonly DiffFile[]): Placement {
  const byName = new Map(files.map((f) => [f.filename, f]));
  const index = new Map<string, ReturnType<typeof commentable>>();
  const out: Placement = { anchored: [], unknown: [], loose: [] };
  for (const f of findings) {
    const file = byName.get(f.file);
    if (file && file.patch === undefined) {
      out.unknown.push(f);
      continue;
    }
    if (file && !index.has(f.file)) index.set(f.file, commentable(file.patch!));
    (index.get(f.file)?.[f.side].has(f.line) ? out.anchored : out.loose).push(f);
  }
  return out;
}
