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

test("the chart's ConfigMap names the session store and its settings, and refuses ones that cannot work", () => {
  const configMap = (...set: string[]) =>
    execFileSync("helm", ["template", "s", "chart", "--show-only", "templates/configmap.yaml", "--set", "config.team=org/team", ...set.flatMap((s) => ["--set", s])], { encoding: "utf8", stdio: "pipe" });
  const sessionKeys = (yaml: string) => yaml.match(/^ {2}(SEIDROID_SESSION_\w+|AWS_REGION): .*$/gm) ?? [];
  assert.deepEqual(sessionKeys(configMap("config.sessions.s3.bucket=seidroid")), ['  SEIDROID_SESSION_STORE: ""']);
  assert.deepEqual(sessionKeys(configMap("config.sessions.store=s3", "config.sessions.s3.bucket=seidroid", "config.sessions.s3.prefix=review/dev", "config.sessions.s3.region=us-east-2")), [
    '  SEIDROID_SESSION_STORE: "s3"',
    '  SEIDROID_SESSION_BUCKET: "seidroid"',
    '  SEIDROID_SESSION_PREFIX: "review/dev"',
    '  AWS_REGION: "us-east-2"',
  ]);
  const refused: [string[], RegExp][] = [
    [["config.sessions.store=s3"], /config\.sessions\.s3\.bucket is required/],
    [["config.sessions.store=gcs"], /config\.sessions\.store/],
    [["config.sessions.bucket=seidroid"], /Additional property bucket/],
    ...["review/../prod", "..", "./review"].map((p): [string[], RegExp] => [["config.sessions.store=s3", "config.sessions.s3.bucket=seidroid", `config.sessions.s3.prefix=${p}`], /config\.sessions\.s3\.prefix/]),
  ];
  for (const [set, err] of refused) assert.throws(() => configMap(...set), (e: { stderr: string }) => err.test(e.stderr), set.join(" "));
});
