const PATTERNS: [string, RegExp][] = [
  ["github token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["github pat", /github_pat_[A-Za-z0-9_]{20,}/],
  ["aws access key id", /(AKIA|ASIA)[0-9A-Z]{16}/],
  ["anthropic api key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai api key", /sk-(proj|svcacct)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{48}/],
  ["google api key", /AIza[0-9A-Za-z_-]{35}/],
  ["gitlab token", /glpat-[A-Za-z0-9_-]{20,}/],
  ["npm token", /npm_[A-Za-z0-9]{36}/],
  ["pypi token", /pypi-[A-Za-z0-9_-]{50,}/],
  ["stripe secret key", /(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ["hugging face token", /hf_[A-Za-z0-9]{30,}/],
  ["age secret key", /AGE-SECRET-KEY-1[0-9A-Z]{20,}/],
  ["slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["slack webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+_-]{20,}/],
  ["pem private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["json web token", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
];

/** scanSecrets names the first credential text carries, a held literal or a known token shape; empty when none. */
export function scanSecrets(text: string, literals: readonly string[] = []): string {
  if (literals.some((l) => l.length >= 8 && text.includes(l))) return "a credential this process holds";
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? "";
}
