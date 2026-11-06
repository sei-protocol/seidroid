import { test } from "node:test";
import assert from "node:assert/strict";
import { all, client } from "../src/github.ts";

function serve(statuses: number[]): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    assert.equal((init.headers as Record<string, string>)["Content-Type"], "application/json");
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? JSON.stringify([1]) : "<html>bad gateway</html>", { status });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

test("client retries a read that failed upstream, but never a write", async (t) => {
  t.mock.method(globalThis, "setTimeout", (f: () => void) => (f(), 0));
  const s = serve([502, 200, 502]);
  try {
    const gh = client("t", "https://api");
    assert.equal((await gh.rest("GET", "/x")).status, 200);
    assert.equal((await gh.rest("POST", "/y", {})).status, 0);
    assert.deepEqual(s.calls, ["GET https://api/x", "GET https://api/x", "POST https://api/y"]);
  } finally {
    s.restore();
  }
});

test("all stops at the first short page", async () => {
  const pages = [Array(100).fill(0), [1]];
  const gh = { rest: async (): Promise<any> => ({ status: 200, data: pages.shift() ?? [] }), graphql: async (): Promise<any> => ({}) };
  const got = await all<number>(gh, "/l");
  assert.equal(got.length, 101);
});
