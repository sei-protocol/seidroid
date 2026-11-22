import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { App } from "../src/app.ts";

test("repos lists every repository of the installations that belong to the given owners", async (t) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: string[] = [];
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `r${i}`, owner: { login: "sei" } }));
  const replies: Record<string, unknown> = {
    "GET /app/installations?per_page=100&page=1": [{ id: 1, account: { login: "sei" } }, { id: 2, account: { login: "other" } }],
    "POST /app/installations/1/access_tokens": { token: "t" },
    "GET /installation/repositories?per_page=100&page=1": { repositories: page(100) },
    "GET /installation/repositories?per_page=100&page=2": { repositories: page(1) },
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url.slice("https://api".length)}`;
    calls.push(key);
    return new Response(JSON.stringify(replies[key]), { status: key.startsWith("POST") ? 201 : 200 });
  });
  const got = await new App("1", privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "https://api").repos(["sei"]);
  assert.equal(got.length, 101);
  assert.deepEqual(got[0], { owner: "sei", repo: "r0" });
  assert.ok(!calls.includes("POST /app/installations/2/access_tokens"));
});
