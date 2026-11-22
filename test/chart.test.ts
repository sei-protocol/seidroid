import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("the chart's HTTPRoute exposes every route the service serves", () => {
  const served = [...readFileSync("src/server.ts", "utf8").matchAll(/^\s+"(?:GET|POST|PUT) (\/\w+)":/gm)].map((m) => m[1]);
  const routed = readFileSync("chart/templates/httproute.yaml", "utf8").match(/range list ((?:"[^"]+"\s*)+)/)?.[1]?.match(/\/\w+/g);
  assert.ok(served.length > 0);
  assert.deepEqual([...(routed ?? [])].sort(), [...new Set(served)].sort());
});

test("the chart's ConfigMap keeps sessions only when given a bucket, and refuses a prefix that climbs", () => {
  const configMap = (...set: string[]) =>
    execFileSync("helm", ["template", "s", "chart", "--show-only", "templates/configmap.yaml", "--set", "config.team=org/team", ...set.flatMap((s) => ["--set", s])], { encoding: "utf8" });
  const sessionKeys = (yaml: string) => yaml.match(/^ {2}(SEIDROID_SESSION_\w+|AWS_REGION): .*$/gm) ?? [];
  assert.deepEqual(sessionKeys(configMap("config.sessions.prefix=review/dev", "config.sessions.region=us-east-2")), []);
  assert.deepEqual(sessionKeys(configMap("config.sessions.bucket=seidroid", "config.sessions.prefix=review/dev", "config.sessions.region=us-east-2")), [
    '  SEIDROID_SESSION_BUCKET: "seidroid"',
    '  SEIDROID_SESSION_PREFIX: "review/dev"',
    '  AWS_REGION: "us-east-2"',
  ]);
  for (const prefix of ["review/../prod", "..", "./review"]) {
    assert.throws(() => configMap("config.sessions.bucket=seidroid", `config.sessions.prefix=${prefix}`), /config\.sessions\.prefix/);
  }
});
