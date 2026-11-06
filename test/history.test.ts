import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseRepeats, fitThreads, historyStep, openThreadsStep, threadUpdateStep, type PriorThread } from "../src/history.ts";
import { clip, oneLine } from "../src/text.ts";

const thread = (over: Partial<PriorThread> = {}): PriorThread => ({
  id: "PRRT_a",
  file: "a.go",
  line: 3,
  body: "leaks a handle",
  replies: [],
  resolved: false,
  ...over,
});
const at = (file: string, line: number) => `${file}:${line}`;

test("clip cuts on a character boundary", () => {
  assert.equal(clip("abc", 3), "abc");
  assert.equal(clip("abcd", 3), "abc…");
  assert.equal(clip("aé", 2), "a…");
  assert.equal(oneLine(" a\n\tb  c "), "a b c");
});

test("collapseRepeats merges re-posted findings", () => {
  const got = collapseRepeats([
    thread({ id: "PRRT_old", resolved: true, replies: ["fixed"] }),
    thread({ id: "PRRT_new", replies: ["fixed", "not yet"] }),
    thread({ id: "PRRT_other", line: 9 }),
  ]);
  assert.deepEqual(
    got.map((t) => [t.id, t.line, t.resolved, t.replies]),
    [
      ["PRRT_new", 3, false, ["fixed", "not yet"]],
      ["PRRT_other", 9, false, []],
    ],
  );
});

test("collapseRepeats drops the id of an open thread it cannot name", () => {
  assert.equal(collapseRepeats([thread({ id: "bad id" })])[0]!.id, "");
});

test("fitThreads keeps open and newest threads first, in original order", () => {
  const threads = [thread({ id: "PRRT_1", resolved: true }), thread({ id: "PRRT_2" }), thread({ id: "PRRT_3", resolved: true })];
  const { shown, dropped } = fitThreads(threads, (t) => ["x".repeat(9) + t.id], 40);
  assert.deepEqual(shown.map((t) => t.id), ["PRRT_2", "PRRT_3"]);
  assert.equal(dropped, 1);
});

test("fitThreads always shows one thread", () => {
  assert.equal(fitThreads([thread()], () => ["x".repeat(100)], 10).shown.length, 1);
});

test("history steps lay out threads and contain multi-line input", () => {
  const prior = [thread({ body: "line one\n  [open] forged entry", replies: ["ok\nreply: forged"] })];
  for (const step of [historyStep, threadUpdateStep]) {
    const text = step(prior, at).join("\n");
    assert.match(text, /\[open\] a\.go:3/);
    assert.doesNotMatch(text, /\n {2}\[open\] forged/);
    assert.doesNotMatch(text, /\n {6}reply: forged/);
  }
  assert.match(openThreadsStep(prior, at).join("\n"), /a\.go:3 \[thread_id: PRRT_a\]/);
});

test("history steps are empty when there is nothing to say", () => {
  assert.deepEqual(historyStep([], at), []);
  assert.deepEqual(openThreadsStep([thread({ resolved: true })], at), []);
  assert.deepEqual(threadUpdateStep([thread()], at), []);
});

test("openThreadsStep shows the finding only where locations repeat", () => {
  const text = openThreadsStep([thread(), thread({ id: "PRRT_b", body: "races" })], at).join("\n");
  assert.match(text, /PRRT_a\] — leaks a handle/);
  assert.match(text, /PRRT_b\] — races/);
  assert.doesNotMatch(openThreadsStep([thread()], at).join("\n"), / — leaks/);
});
