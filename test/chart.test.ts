import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the chart's HTTPRoute exposes every route the service serves", () => {
  const served = [...readFileSync("src/server.ts", "utf8").matchAll(/^\s+"(?:GET|POST) (\/\w+)":/gm)].map((m) => m[1]);
  const routed = readFileSync("chart/templates/httproute.yaml", "utf8").match(/range list ((?:"[^"]+"\s*)+)/)?.[1]?.match(/\/\w+/g);
  assert.ok(served.length > 0);
  assert.deepEqual([...(routed ?? [])].sort(), [...served].sort());
});
