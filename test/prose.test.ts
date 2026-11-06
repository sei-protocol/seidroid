import { test } from "node:test";
import assert from "node:assert/strict";
import { prose } from "../src/prose.ts";

test("prose fills a prompt once and never expands a value", () => {
  assert.equal(prose("review", { repo: "o/r", pr: "{{pr}}" }), "Review pull request o/r#{{pr}} as the seidroid review bot.");
});

test("prose refuses a prompt missing one of its values", () => {
  assert.throws(() => prose("review", { repo: "o/r" }), /needs a value for \{\{pr\}\}/);
  assert.throws(() => prose("review", { repo: "o/r", toString: "x" }), /\{\{pr\}\}/);
});

