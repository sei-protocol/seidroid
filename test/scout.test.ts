import { test } from "node:test";
import assert from "node:assert/strict";
import { readingOf, scoutPrompt, settleByScouts } from "../src/scout.ts";

const inert = { read: 4, inert: true, findings: [] };

test("readingOf turns a missing or unread submission into a note", () => {
  assert.equal(readingOf("codex", "timed out").note, "timed out");
  assert.equal(readingOf("codex", { ...inert, read: 0 }).note, "it could not read the diff");
  assert.deepEqual(readingOf("codex", inert), { name: "codex", note: "", ...inert });
});

test("settleByScouts approves only when every scout read an inert, clean diff", () => {
  const settled = settleByScouts([readingOf("a", inert), readingOf("b", { ...inert, read: 9 })], 4);
  assert.equal(settled?.decision, "approve");
  assert.equal(settled?.read, 4);
  assert.match(settled!.summary, /\(a, b\)/);
  for (const other of [
    readingOf("b", "failed"),
    readingOf("b", { ...inert, inert: false }),
    readingOf("b", { ...inert, findings: [{ file: "a", line: 1, severity: "low", detail: "x" }] }),
  ]) {
    assert.equal(settleByScouts([readingOf("a", inert), other], 4), undefined);
  }
  assert.equal(settleByScouts([readingOf("a", inert)], 5), undefined, "read part of the diff");
  assert.equal(settleByScouts([], 4), undefined);
});

test("scoutPrompt points at the diff and the submit tool", () => {
  const p = scoutPrompt({ repo: "o/r", pr: 3, diffLines: 10 });
  assert.match(p, /o\/r#3/);
  assert.match(p, /pr\.diff in your working directory, 10 lines/);
  assert.match(p, /submit_findings/);
  assert.match(p, /build constraint/);
});
