import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSubmission, verdictOf, type Verdict } from "../src/verdict.ts";
import { checkOutput, defuse, findingComment, fit, MARKER, noVerdict, reviewBody, summaryComment } from "../src/render.ts";

function verdict(raw: object, accepted: string[] = []): Verdict {
  const parsed = parseSubmission({ read: 10, decision: "approve", summary: "Adds a thing.", ...raw });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return verdictOf(parsed.submission, accepted, "main");
}

const finding = (over: object = {}) => ({ path: "a.go", line: 2, severity: "suggestion", body: "x", ...over });

test("defuse keeps model text from opening blocks or HTML", () => {
  for (const [input, want] of [
    ["# title", "\\# title"],
    ["  > quote", "  \\> quote"],
    ["- item", "\\- item"],
    ["12. step", "12\\. step"],
    ["```go", "\\```go"],
    ["---", "\\---"],
    ["| a | b |", "\\| a | b |"],
    ["see <details>", "see \\<details>"],
    ["already \\<b>", "already \\<b>"],
    ["a < b and 3.5", "a < b and 3.5"],
    ["-1 is fine", "-1 is fine"],
  ]) {
    assert.equal(defuse(input!), want, input);
  }
});

test("reviewBody names the position the verdict was forced to", () => {
  const forced = reviewBody(verdict({ inline_comments: [finding({ severity: "blocker", body: "panics" })] }), false);
  assert.match(forced, /\*\*Changes requested\.\*\* The review wrote `approve`.*: panics\./);
  assert.match(forced, /_1 blocking finding on the changed lines, as inline comments\._/);
  assert.match(reviewBody(verdict({ read: 0 }), false), /Approval withheld.*read: 0/);
  assert.match(reviewBody(verdict({ decision: "comment" }), false), /No position recorded/);
  const pre = verdict({ pre_existing_issues: [{ severity: "blocker", body: "the cache is unbounded" }] });
  assert.match(reviewBody(pre, false), /Approval withheld.*`main`'s review standards/);
  assert.doesNotMatch(reviewBody(verdict({}), false), /Approval|Changes requested|No position/);
});

test("reviewBody lists what has no line in the diff and folds nits", () => {
  const v = verdict({
    blockers: ["breaks the API"],
    non_blockers: ["worth a test"],
    inline_comments: [finding({ path: "/etc/passwd", body: "off" }), finding({ severity: "nit", body: "rename" })],
    pre_existing_issues: [{ severity: "blocker", body: "the unbounded cache stays" }],
  }, ["unbounded cache"]);
  const body = reviewBody(v, false);
  assert.match(body, /\*\*Blocking\*\*\n\n- breaks the API/);
  assert.match(body, /\*\*Non-blocking\*\*\n\n- worth a test\n- `\/etc\/passwd:2` — off/);
  assert.match(body, /Accepted pre-existing blocker.*\(unbounded cache\)/);
  assert.match(body, /<details><summary>1 nit, not posted on the code<\/summary>[\s\S]*`a.go:2` — rename/);
  assert.doesNotMatch(reviewBody(v, true), /<details>/);
});

test("reviewBody lists a finding that landed nowhere and stops counting it inline", () => {
  const v = verdict({ inline_comments: [finding({ severity: "blocker", body: "panics" })] });
  const body = reviewBody(v, false, [{ file: "a.go", line: 2, side: "RIGHT", severity: "blocker", detail: "panics", supersedes: [] }]);
  assert.match(body, /\*\*Blocking\*\*\n\n- `a.go:2` — panics/);
  assert.doesNotMatch(body, /as inline comments/);
  const nit = { file: "a.go", line: 2, side: "RIGHT" as const, severity: "nit" as const, detail: "rename", supersedes: [] };
  assert.doesNotMatch(reviewBody(v, false, [nit]), /rename/);
  assert.match(checkOutput(v, false, [{ ...nit, severity: "blocker", detail: "panics" }]).summary, /- `a.go:2` — panics/);
});

test("section caps its entries", () => {
  const body = reviewBody(verdict({ non_blockers: Array.from({ length: 60 }, (_, i) => `n${i}`) }), false);
  assert.equal(body.match(/^- n\d+$/gm)?.length, 50);
  assert.match(body, /and 10 more/);
});

test("fit cuts a body within the byte limit", () => {
  const cut = fit("é".repeat(40_000), 1_000);
  assert.ok(Buffer.byteLength(cut) <= 1_000);
  assert.match(cut, /Cut to fit/);
  assert.equal(fit("short"), "short");
});

test("summaryComment and findingComment carry their markers", () => {
  const settled = verdictOf({ read: 3, decision: "approve", summary: "Docs only." }, [], "");
  settled.settledBy = "codex";
  const s = summaryComment(settled, false, "https://run");
  assert.ok(s.startsWith(MARKER.verdict + "\n"));
  assert.match(s, /settled by codex with no review turn · \[run\]\(https:\/\/run\)/);
  const f = { file: "a.go", line: 3, side: "RIGHT" as const, severity: "blocker" as const, detail: "panics", supersedes: [] };
  assert.equal(findingComment(f), `${MARKER.finding}\n**blocker** — panics`);
  assert.match(findingComment(f, true), /Cited at `a.go:3`, outside this diff's changed lines/);
});

test("checkOutput concludes and counts the verdict", () => {
  const v = verdict({ blockers: ["b"], inline_comments: [finding(), finding({ severity: "nit" })], pre_existing_issues: [{ severity: "suggestion", body: "p" }] });
  const c = checkOutput(v, false);
  assert.equal(c.conclusion, "failure");
  assert.equal(c.title, "2 findings, 1 pre-existing");
  assert.equal(checkOutput(verdict({}), false).title, "0 findings");
  const nv = noVerdict("pi exited with 1\n# boom", "https://run");
  assert.match(nv.comment, /^<!-- seidroid-review:no-verdict -->\n\*\*This review did not complete\.\*\*.*pi exited with 1 # boom\./);
  assert.deepEqual(nv.check, { conclusion: "failure", title: "No verdict", summary: "pi exited with 1 # boom" });
});
