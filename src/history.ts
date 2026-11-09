import { wellFormedThreadId } from "./verdict.ts";
import { block, prose } from "./prose.ts";
import { byteLength, clip, oneLine } from "./text.ts";

export const MAX_HISTORY_BYTES = 60_000;
const MAX_PRIOR_REPLIES = 10;
export const MAX_DETAIL = 500;
export const MAX_FIELD = 120;

/** PriorThread is one review thread seidroid opened on the pull request, with its replies. */
export interface PriorThread {
  id: string;
  file: string;
  line: number;
  body: string;
  replies: string[];
  resolved: boolean;
}

/** Locate names a place in the reviewed tree the way the prompt shows it. */
export type Locate = (file: string, line: number) => string;

/**
 * collapseRepeats merges threads that carry the same finding at the same place, as a
 * review re-posted on every push leaves them. The merged thread is resolved only if all
 * were, keeps every distinct reply, and keeps an open thread's id over a resolved one's.
 */
export function collapseRepeats(threads: readonly PriorThread[]): PriorThread[] {
  type Found = { thread: PriorThread; last: number; openHandle: boolean };
  const at = new Map<string, Found>();
  threads.forEach((t, i) => {
    const key = [t.file, t.line, t.body].join("\0");
    const f = at.get(key);
    if (!f) {
      at.set(key, { thread: { ...t, replies: [...t.replies] }, last: i, openHandle: !t.resolved && wellFormedThreadId(t.id) });
      return;
    }
    f.thread.resolved &&= t.resolved;
    for (const r of t.replies) if (!f.thread.replies.includes(r)) f.thread.replies.push(r);
    f.last = i;
    if (wellFormedThreadId(t.id) && (!t.resolved || !f.openHandle)) {
      f.thread.id = t.id;
      f.openHandle = !t.resolved;
    }
  });
  return [...at.values()]
    .sort((a, b) => a.last - b.last)
    .map((f) => (!f.thread.resolved && !f.openHandle ? { ...f.thread, id: "" } : f.thread));
}

/**
 * fitThreads keeps the threads whose entries fit the byte budget, open ones and then the
 * newest first, and returns them in their original order with the count dropped.
 */
export function fitThreads(
  threads: readonly PriorThread[],
  entryOf: (t: PriorThread) => string[],
  budget = MAX_HISTORY_BYTES,
): { shown: PriorThread[]; dropped: number } {
  const order = [false, true].flatMap((resolved) =>
    threads.flatMap((t, i) => (t.resolved === resolved ? [i] : [])).reverse(),
  );
  const keep = new Set<number>();
  let size = 0;
  for (const [n, i] of order.entries()) {
    const cost = entryOf(threads[i]!).reduce((sum, line) => sum + byteLength(line) + 1, 0);
    if (n > 0 && size + cost > budget) break;
    size += cost;
    keep.add(i);
  }
  return { shown: threads.filter((_, i) => keep.has(i)), dropped: threads.length - keep.size };
}

const state = (t: PriorThread): string => (t.resolved ? "resolved" : "open");
const handle = (t: PriorThread): string => (wellFormedThreadId(t.id) ? ` [thread_id: ${t.id}]` : "");
const replyLines = (t: PriorThread): string[] =>
  t.replies.slice(-MAX_PRIOR_REPLIES).map((r) => `      reply: ${clip(oneLine(r), MAX_DETAIL)}`);

/** listing is the entries shown, then a note on how many did not fit. */
function listing(entries: string[], dropped: number): string {
  return [...entries, ...(dropped === 0 ? [] : ["", prose("dropped", { count: dropped })])].join("\n");
}

function repeatedLocations(locate: Locate, threads: readonly PriorThread[]): Map<string, number> {
  const at = new Map<string, number>();
  for (const t of threads) {
    const where = locate(t.file, t.line);
    at.set(where, (at.get(where) ?? 0) + 1);
  }
  return at;
}

/** historyStep tells a first review what seidroid already said on the pull request. */
export function historyStep(prior: readonly PriorThread[], locate: Locate): string[] {
  if (prior.length === 0) return [];
  const threads = collapseRepeats(prior);
  const entryOf = (t: PriorThread) => [
    `  [${state(t)}] ${locate(t.file, t.line)}${handle(t)} — ${clip(oneLine(t.body), MAX_DETAIL)}`,
    ...replyLines(t),
  ];
  const { shown, dropped } = fitThreads(threads, entryOf);
  const entries = listing(shown.flatMap(entryOf), dropped);
  return block("history", { count: threads.length, shown: shown.length, entries });
}

/** openThreadsStep lists the ids a re-review may resolve or supersede. */
export function openThreadsStep(prior: readonly PriorThread[], locate: Locate): string[] {
  const open = prior.filter((t) => !t.resolved && wellFormedThreadId(t.id));
  if (open.length === 0) return [];
  const repeats = repeatedLocations(locate, open);
  const entryOf = (t: PriorThread) => {
    const where = locate(t.file, t.line);
    const tail = (repeats.get(where) ?? 0) > 1 ? ` — ${clip(oneLine(t.body), MAX_DETAIL)}` : "";
    return [`  ${where}${handle(t)}${tail}`];
  };
  const { shown, dropped } = fitThreads(open, entryOf);
  return block("open-threads", { entries: listing(shown.flatMap(entryOf), dropped) });
}

/** threadUpdateStep tells a re-review which of its threads were replied to or resolved. */
export function threadUpdateStep(prior: readonly PriorThread[], locate: Locate): string[] {
  const all = collapseRepeats(prior);
  const changed = all.filter((t) => t.resolved || t.replies.length > 0);
  if (changed.length === 0) return [];
  const repeats = repeatedLocations(locate, all);
  const entryOf = (t: PriorThread) => {
    const where = locate(t.file, t.line);
    const tail = (repeats.get(where) ?? 0) > 1 ? ` — ${clip(oneLine(t.body), MAX_DETAIL)}` : "";
    return [`  [${state(t)}] ${where}${tail}`, ...replyLines(t)];
  };
  const { shown, dropped } = fitThreads(changed, entryOf);
  return block("thread-updates", { entries: listing(shown.flatMap(entryOf), dropped) });
}
