import { test } from "node:test";
import assert from "node:assert/strict";
import { carriesOn, crossCheck, crossChecks, readingOf, scoutPrompt, settleByScouts } from "../src/scout.ts";

const inert = { read: 4, inert: true, findings: [] };

test("readingOf turns a missing or unread submission into a note that names no model", () => {
  assert.equal(readingOf("the cross-check", "no model credential: openai/gpt-x").note, "it did not finish its reading");
  assert.equal(readingOf("codex", { ...inert, read: 0 }).note, "it could not read the diff");
  assert.deepEqual(readingOf("codex", inert), { name: "codex", note: "", ...inert });
});

test("crossCheck labels one scout alone and several by position", () => {
  assert.equal(crossCheck(0, 1), "the cross-check");
  assert.deepEqual([0, 1, 2].map((i) => crossCheck(i, 3)), ["cross-check A", "cross-check B", "cross-check C"]);
  assert.equal(crossCheck(26, 27), "cross-check 27");
  assert.deepEqual([1, 2, 3].map(crossChecks), ["the cross-check", "both cross-checks", "all 3 cross-checks"]);
});

test("settleByScouts approves only when every scout read an inert, clean diff", () => {
  const settled = settleByScouts([readingOf("cross-check A", inert), readingOf("cross-check B", { ...inert, read: 9 })], 4);
  assert.equal(settled?.decision, "approve");
  assert.equal(settled?.read, 4);
  assert.match(settled!.summary, /^Settled by both cross-checks without a review turn: /);
  assert.match(settleByScouts([readingOf("openai/gpt-x", inert)], 4)!.summary, /^Settled by the cross-check without a review turn: /);
  assert.doesNotMatch(settleByScouts([readingOf("openai/gpt-x", inert)], 4)!.summary, /gpt|openai/);
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
  assert.match(p, /read is the diff's line count/);
});

test("scoutPrompt with an earlier reading points at what changed and what it found then", () => {
  const p = scoutPrompt({ repo: "o/r", pr: 3, diffLines: 10, since: { lines: 4, findings: [{ file: "a.go", line: 5, severity: "high", detail: "x\ny" }] } });
  assert.match(p, /since\.diff in your working directory, 4\s+lines/);
  assert.match(p, /pr\.diff, 10\s+lines/);
  assert.match(p, /^  high a\.go:5 — x y$/m);
  assert.match(p, /read is since\.diff's line count/);
  assert.match(scoutPrompt({ repo: "o/r", pr: 3, diffLines: 10, since: { lines: 4, findings: [] } }), /^  \(nothing\)$/m);
});

test("carriesOn lists every earlier finding or none", () => {
  const f = { file: "a.go", line: 1, severity: "low" as const, detail: "d" };
  assert.equal(carriesOn(Array(25).fill(f)), true);
  assert.equal(carriesOn(Array(26).fill(f)), false);
});
