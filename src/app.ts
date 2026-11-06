import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { client, type GitHub } from "./github.ts";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** App mints installation tokens for the seidroid GitHub App, one repository at a time. */
export class App {
  private readonly id: string;
  private readonly key: KeyObject;
  private readonly api: string;
  private readonly tokens = new Map<string, { token: string; expires: number }>();
  private login?: string;

  constructor(id: string, privateKey: string, api = "https://api.github.com") {
    this.id = id;
    this.key = createPrivateKey(privateKey);
    this.api = api;
  }

  /** jwt is the App's own short-lived bearer token. */
  jwt(now = Math.floor(Date.now() / 1000)): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: this.id })}`;
    return `${body}.${sign("RSA-SHA256", Buffer.from(body), this.key).toString("base64url")}`;
  }

  /** forRepo returns a client acting as the App's installation, scoped to owner/repo. */
  async forRepo(owner: string, repo: string): Promise<GitHub> {
    const key = `${owner}/${repo}`;
    let t = this.tokens.get(key);
    if (!t || t.expires - REFRESH_MARGIN_MS < Date.now()) {
      const app = client(this.jwt(), this.api);
      const inst = await app.rest<{ id: number }>("GET", `/repos/${owner}/${repo}/installation`);
      if (inst.status !== 200) throw new Error(`the App is not installed on ${key}: ${inst.status}`);
      const res = await app.rest<{ token: string; expires_at: string }>("POST", `/app/installations/${inst.data.id}/access_tokens`, { repositories: [repo] });
      if (res.status !== 201) throw new Error(`could not mint a token for ${key}: ${res.status}`);
      t = { token: res.data.token, expires: Date.parse(res.data.expires_at) };
      this.tokens.set(key, t);
    }
    return client(t.token, this.api);
  }

  /** bot is the login the App posts as, e.g. seidroid[bot]. */
  async bot(): Promise<string> {
    if (!this.login) {
      const res = await client(this.jwt(), this.api).rest<{ slug: string }>("GET", "/app");
      if (res.status !== 200) throw new Error(`could not read the App: ${res.status}`);
      this.login = `${res.data.slug}[bot]`;
    }
    return this.login;
  }
}
