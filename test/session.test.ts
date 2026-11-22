import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { files, MAX_SESSION, pack, unpack } from "../src/session.ts";

const temp = () => mkdtempSync(path.join(tmpdir(), "seidroid-session-"));

test("pack and unpack carry a session's files over, as a tar that tar reads", () => {
  const dir = temp();
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "2026_seidroid.jsonl"), '{"type":"session"}\n');
  writeFileSync(path.join(dir, "sub", "scouts.json"), "{}");
  const packed = pack(dir);
  const out = temp();
  unpack(packed, out);
  assert.deepEqual(readdirSync(out, { recursive: true }).sort(), ["2026_seidroid.jsonl", "sub", path.join("sub", "scouts.json")]);
  assert.equal(readFileSync(path.join(out, "sub", "scouts.json"), "utf8"), "{}");
  assert.deepEqual(execFileSync("tar", ["-tf", "-"], { input: zstdDecompressSync(packed) }).toString().split("\n").filter(Boolean), ["2026_seidroid.jsonl", "sub/scouts.json"]);
});

test("pack refuses a session holding a link", () => {
  const dir = temp();
  symlinkSync("/etc/passwd", path.join(dir, "passwd"));
  assert.throws(() => pack(dir), /not a regular file/);
});

test("files refuses an archive that reaches outside the session or holds anything but files", () => {
  const tarOf = (setup: (dir: string) => string[], ...flags: string[]) => {
    const dir = temp();
    return zstdCompressSync(execFileSync("tar", ["--format=ustar", "-P", "-C", dir, ...flags, "-cf", "-", ...setup(dir)]));
  };
  const file = (dir: string) => (writeFileSync(path.join(dir, "f"), "x"), ["f"]);
  const cases: [Buffer, RegExp][] = [
    [tarOf(file, "--transform", "s,^,../,"), /outside it/],
    [tarOf(file, "--transform", "s,^,sub/../../,"), /outside it/],
    [tarOf(file, "--transform", "s,^,/tmp/,"), /outside it/],
    [tarOf((dir) => (symlinkSync("/etc", path.join(dir, "l")), ["l"])), /not a regular file/],
    [tarOf((dir) => (writeFileSync(path.join(dir, "f"), "x"), execFileSync("ln", [path.join(dir, "f"), path.join(dir, "g")]), ["f", "g"])), /not a regular file/],
    [zstdCompressSync(Buffer.alloc(1024, 1)), /corrupt header/],
    [zstdCompressSync(Buffer.alloc(100)), /ends early/],
    [zstdCompressSync(Buffer.alloc(65 << 20)), /larger than/],
    [Buffer.alloc(MAX_SESSION + 1), /over/],
  ];
  for (const [packed, want] of cases) assert.throws(() => files(packed), want);
  const ok = tarOf(file);
  assert.deepEqual([...files(ok).keys()], ["f"]);
});
