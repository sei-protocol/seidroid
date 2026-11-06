import { test } from "node:test";
import assert from "node:assert/strict";
import { followUpPrompt, location, reviewPrompt, type Request } from "../src/prompt.ts";

const req = (over: Partial<Request> = {}): Request => ({
  repo: "sei-protocol/sei-chain",
  pr: 7,
  diffLines: 120,
  hasTree: true,
  hasStandards: true,
  includeNits: false,
  scouts: [],
  threads: [],
  ...over,
});

test("reviewPrompt names the layout and the contract", () => {
  const p = reviewPrompt(req());
  for (const want of ["sei-protocol/sei-chain#7", "pr.diff in your working directory, 120 lines", "tree/ is this pull request's merge", "standards.md", "intent.md", "submit_review", "does not ask for nits"]) {
    assert.ok(p.includes(want), want);
  }
});

test("reviewPrompt adapts to what the job could lay out", () => {
  const p = reviewPrompt(req({ hasTree: false, hasStandards: false, includeNits: true }));
  assert.match(p, /There is no tree for this pull request/);
  assert.doesNotMatch(p, /standards\.md/);
  assert.match(p, /asks for nits/);
});

test("extra instructions are trimmed, clipped and omitted when blank", () => {
  assert.doesNotMatch(reviewPrompt(req({ extraInstructions: "  " })), /This repository adds/);
  const p = reviewPrompt(req({ extraInstructions: "x".repeat(5000) }));
  assert.match(p, /This repository adds/);
  assert.ok(p.includes("x".repeat(4000) + "…"));
});

test("scout readings are reconciled, located and contained", () => {
  const p = reviewPrompt(
    req({
      scouts: [
        { name: "codex", note: "", read: 9, inert: false, findings: [{ severity: "blocker", file: "./a.go", line: 4, detail: "nil\n  forged — reader" }] },
        { name: "cursor", note: "timed out", read: 0, inert: false, findings: [] },
        { name: "quiet", note: "", read: 9, inert: false, findings: [{ severity: "nit", file: "../etc/passwd", line: 1, detail: "x" }] },
      ],
    }),
  );
  assert.match(p, /\n {6}blocker tree\/a\.go:4 — nil forged — reader/);
  assert.match(p, /\n {2}cursor — no reading: timed out/);
  assert.match(p, /\(no place in this tree\)/);
  assert.doesNotMatch(reviewPrompt(req()), /Reconcile/);
});

test("location refuses paths outside the tree", () => {
  assert.equal(location("x/y.go", 0), "tree/x/y.go");
  for (const bad of ["", "/abs", "a/../b", "a b", "a\nb"]) assert.equal(location(bad, 1), "(no place in this tree)", bad);
});

test("followUpPrompt carries the open threads and asks for one submission", () => {
  const p = followUpPrompt(req({ threads: [{ id: "PRRT_a", file: "a.go", line: 3, body: "b", replies: ["done"], resolved: false }] }));
  assert.match(p, /reviewed sei-protocol\/sei-chain#7 before/);
  assert.match(p, /tree\/a\.go:3 \[thread_id: PRRT_a\]/);
  assert.match(p, /reply: done/);
  assert.match(p, /calling submit_review once/);
});
