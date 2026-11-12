import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import seidroid, { within } from "../src/extension.ts";
import { canSandbox } from "../src/sandbox.ts";

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

test("with a home, bash is offered and runs in the sandbox", async () => {
  type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };
  type Handler = (e: { toolName: string; input: Record<string, unknown> }) => Promise<{ block: true } | undefined>;
  const tools: Tool[] = [];
  let gate: Handler | undefined;
  const home = mkdtempSync(path.join(tmpdir(), "home-"));
  const cwd = process.cwd();
  Object.assign(process.env, { SEIDROID_OUT: path.join(root, "submission.json"), SEIDROID_SUBMIT: "review", SEIDROID_HOME: home, SEIDROID_PROBE: "held" });
  process.chdir(root);
  try {
    seidroid({ on: (_: string, h: Handler) => (gate = h), registerTool: (t: Tool) => tools.push(t) } as never);
  } finally {
    process.chdir(cwd);
    delete process.env.SEIDROID_HOME;
  }
  assert.deepEqual(tools.map((t) => t.name), ["bash", "submit_review"]);
  assert.equal(await gate!({ toolName: "bash", input: { command: "env" } }), undefined);
  assert.ok(await gate!({ toolName: "write", input: { path: "x" } }));
  if (!canSandbox()) return;
  const r = await tools[0].execute("1", { command: "env; echo home=$HOME" }, undefined, undefined, {});
  const text = r.content.map((c) => c.text).join("");
  assert.match(text, new RegExp(`home=${home}`));
  assert.doesNotMatch(text, /SEIDROID_PROBE|SEIDROID_OUT/);
});
