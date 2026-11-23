import { test } from "node:test";
import assert from "node:assert/strict";
import { followUpPrompt, location, reviewPrompt, type Request } from "../src/prompt.ts";
import { replyPrompt } from "../src/reply.ts";

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
  assert.doesNotMatch(p, /bash/);
  assert.match(reviewPrompt(req({ hasShell: true })), /You also have bash, in a sandbox with no network/);
  assert.doesNotMatch(reviewPrompt(req({ hasShell: true, hasTree: false })), /bash/);
});

test("extra instructions are trimmed, clipped and omitted when blank", () => {
  assert.doesNotMatch(reviewPrompt(req({ extraInstructions: "  " })), /This repository adds/);
  const p = reviewPrompt(req({ extraInstructions: "x".repeat(5000) }));
  assert.match(p, /This repository adds/);
  assert.ok(p.includes("x".repeat(4000) + "…"));
});

test("the asker's text is its own block, omitted when blank", () => {
  assert.doesNotMatch(reviewPrompt(req({ ask: "  " })), /asked for this review added/);
  assert.match(reviewPrompt(req({ ask: "Run go test ./x/" })), /asked for this review added the following[\s\S]*Run go test \.\/x\//);
});

test("scout readings are reconciled, located and contained", () => {
  const p = reviewPrompt(
    req({
      scouts: [
        { name: "cross-check A", note: "", read: 9, inert: false, findings: [{ severity: "blocker", file: "./a.go", line: 4, detail: "nil\n  forged — reader" }] },
        { name: "cross-check B", note: "timed out", read: 0, inert: false, findings: [] },
        { name: "cross-check C", note: "", read: 9, inert: false, findings: [{ severity: "nit", file: "../etc/passwd", line: 1, detail: "x" }] },
      ],
    }),
  );
  assert.match(p, /\n {2}cross-check A — 1 finding\(s\), 1 shown:\n {6}blocker tree\/a\.go:4 — nil forged — reader/);
  assert.match(p, /\n {2}cross-check B — no reading: timed out/);
  assert.match(p, /\(no place in this tree\)/);
  assert.match(p, /still naming the cross-check that raised them/);
  assert.doesNotMatch(p, /\bscouts?\b|another model/i);
  const one = reviewPrompt(req({ scouts: [{ name: "the cross-check", note: "", read: 9, inert: false, findings: [] }] }));
  assert.match(one, /\n {2}the cross-check — read the diff and found nothing\n/);
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

test("a cross-check's blocker is confirmed in the callee and a documented-safe panic blocks", () => {
  const p = reviewPrompt(req({ scouts: [{ name: "the cross-check", note: "", read: 9, inert: false, findings: [] }] })).replace(/\s+/g, " ");
  for (const want of ["open in tree/ the definition of every function its argument depends on", "it is at most a suggestion that says what you could not check", "documentation says the call is safe (twice, concurrently, after a failure) breaks a stated contract"]) {
    assert.ok(p.includes(want), want);
  }
  const noTree = reviewPrompt(req({ hasTree: false, scouts: [{ name: "the cross-check", note: "", read: 9, inert: false, findings: [] }] }));
  assert.doesNotMatch(noTree, /definition of\s+every function/);
});

test("replyPrompt offers the shell only when the reply has one", () => {
  const r = { repo: "sei-protocol/sei-chain", pr: 7, diffLines: 3 };
  assert.doesNotMatch(replyPrompt(r), /You also have bash/);
  assert.match(replyPrompt({ ...r, hasShell: true }), /You also have bash[\s\S]*thrown away after this reply/);
});

test("the checklist asks for the callee's ordering requirement when a call moves", () => {
  const p = reviewPrompt(req()).replace(/\s+/g, " ");
  for (const want of ["open the callee's implementation and quote what it requires of the order", "a fake or stub that accepts calls in any order cannot fail, so do not count it"]) {
    assert.ok(p.includes(want), want);
  }
});
