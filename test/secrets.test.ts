import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSecrets } from "../src/secrets.ts";

test("scanSecrets names a credential by shape or by a held literal", () => {
  assert.equal(scanSecrets("token ghp_" + "a".repeat(36)), "github token");
  assert.equal(scanSecrets("-----BEGIN RSA PRIVATE KEY-----"), "pem private key");
  assert.equal(scanSecrets("key AKIA" + "A".repeat(16)), "aws access key id");
  assert.equal(scanSecrets("the value hunter22x leaked", ["hunter22x"]), "a credential this process holds");
  assert.equal(scanSecrets("short abc", ["abc"]), "");
  assert.equal(scanSecrets("a clean review of ghp handling"), "");
});
