import { test } from "node:test";
import assert from "node:assert/strict";
import { commentable, partition } from "../src/place.ts";
import type { Finding } from "../src/verdict.ts";

const patch = ["@@ -10,3 +10,4 @@ func f() {", " keep", "-old", "+new", "+added", " tail", "@@ -40 +41 @@", "-gone", "+here"].join("\n");

test("commentable maps each side's lines in a patch", () => {
  const got = commentable(patch);
  assert.deepEqual([...got.RIGHT], [10, 11, 12, 13, 41]);
  assert.deepEqual([...got.LEFT], [10, 11, 12, 40]);
});

test("partition sorts findings by where GitHub can anchor them", () => {
  const at = (file: string, line: number, side: Finding["side"] = "RIGHT"): Finding => ({ file, line, side, severity: "suggestion", detail: "x", supersedes: [] });
  const files = [{ filename: "a.go", patch }, { filename: "big.bin" }];
  const got = partition([at("a.go", 12), at("a.go", 40, "LEFT"), at("a.go", 30), at("a.go", 40), at("big.bin", 1), at("other.go", 1)], files);
  assert.deepEqual(got.anchored.map((f) => f.line), [12, 40]);
  assert.deepEqual(got.unknown.map((f) => f.file), ["big.bin"]);
  assert.deepEqual(got.loose.map((f) => `${f.file}:${f.line}`), ["a.go:30", "a.go:40", "other.go:1"]);
});
