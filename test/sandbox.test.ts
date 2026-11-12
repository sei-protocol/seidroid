import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canSandbox, sandboxed } from "../src/sandbox.ts";

test("a sandboxed command sees no credential, network, process or file outside its jail", { skip: !canSandbox() && "bubblewrap cannot sandbox here" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "jail-"));
  const work = path.join(root, "work");
  const home = path.join(root, "home");
  mkdirSync(work);
  mkdirSync(home);
  writeFileSync(path.join(root, "token"), "secret");
  const jail = { work, home, path: process.env.PATH! };
  const sh = (command: string) =>
    spawnSync("bash", ["-c", sandboxed(command, jail)], { env: { PATH: process.env.PATH, SECRET: "s3cr3t" }, encoding: "utf8" });

  const r = sh(`echo "it's $PWD"; env; awk -F: 'NR>2{print "if"$1}' /proc/net/dev; ls /proc | grep -c '^[0-9]'; touch out "$HOME/cache"; cat ${root}/token; touch /usr/x`);
  assert.match(r.stdout, new RegExp(`^it's ${work}$`, "m"));
  assert.doesNotMatch(r.stdout, /s3cr3t|secret/);
  assert.deepEqual(r.stdout.match(/^if.*$/gm)?.map((l) => l.replace(/\s/g, "")), ["iflo"]);
  assert.ok(Number(r.stdout.match(/^(\d+)$/m)?.[1]) < 5, "host processes are visible");
  assert.ok(spawnSync("test", ["-f", path.join(work, "out")]).status === 0 && spawnSync("test", ["-f", path.join(home, "cache")]).status === 0);
  assert.match(r.stderr, /token: No such file/);
  assert.match(r.stderr, /\/usr\/x'?: Read-only file system/);
  assert.equal(sh("exit 3").status, 3);
});
