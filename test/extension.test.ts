import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import seidroid, { within } from "../src/extension.ts";

const root = mkdtempSync(path.join(tmpdir(), "seidroid-"));
mkdirSync(path.join(root, "tree"));
writeFileSync(path.join(root, "pr.diff"), "diff");
symlinkSync("/etc", path.join(root, "tree", "escape"));

test("within allows only existing paths inside the root", () => {
  assert.equal(within(root, "pr.diff"), path.join(root, "pr.diff"));
  assert.ok(within(root, "."));
  for (const bad of ["../", "/etc/passwd", "tree/escape", "tree/escape/hosts", "~/.ssh", "@pr.diff", "missing"]) {
    assert.equal(within(root, bad), undefined, bad);
  }
});

test("the extension gates tools and writes the submission", async () => {
  type Handler = (e: { toolName: string; input: Record<string, unknown> }) => Promise<{ block: true } | undefined>;
  let gate: Handler | undefined;
  let tool: { name: string; execute: (id: string, params: unknown) => Promise<{ terminate?: boolean }> } | undefined;
  const out = path.join(root, "submission.json");
  const cwd = process.cwd();
  process.env.SEIDROID_OUT = out;
  process.env.SEIDROID_SUBMIT = "review";
  process.chdir(root);
  try {
    seidroid({ on: (_: string, h: Handler) => (gate = h), registerTool: (t: typeof tool) => (tool = t) } as never);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(tool?.name, "submit_review");
  const input = { path: "pr.diff" };
  assert.equal(await gate!({ toolName: "read", input }), undefined);
  assert.equal(input.path, path.join(root, "pr.diff"));
  assert.ok(await gate!({ toolName: "read", input: { path: "/etc/passwd" } }));
  assert.ok(await gate!({ toolName: "bash", input: { command: "env" } }));
  assert.equal(await gate!({ toolName: "submit_review", input: {} }), undefined);
  const result = await tool!.execute("1", { read: 1, decision: "approve", summary: "ok" });
  assert.equal(result.terminate, true);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { read: 1, decision: "approve", summary: "ok" });
});
