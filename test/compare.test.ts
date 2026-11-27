import assert from "node:assert/strict";
import { test } from "node:test";
import { settlement } from "../src/compare.ts";

test("settlement keeps a v2 check run's recorded findings and sends no output for a run without them", () => {
  const cases: [string, { title: string | null; summary: string | null; text: string | null }, object][] = [
    ["a recorded review", { title: "2 findings", summary: "sum", text: "record" }, { external_id: "compare:v1:1", output: { title: "2 findings", summary: "sum", text: "record" } }],
    ["no verdict", { title: "No verdict", summary: "timed out", text: null }, { external_id: "compare:v1:1" }],
  ];
  for (const [name, output, want] of cases) assert.deepEqual(settlement({ output }, "compare:v1:1"), want, name);
});
