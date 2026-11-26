# seidroid

`seidroid[bot]` is Sei's AI reviewer for GitHub. This repository is the next generation of
its review: the same review contract, run in [pi](https://pi.dev) on the caller's GitHub
runner, with no session server, sandbox or teardown. One ref of this repository pins the
whole review.

It is in development, and runs beside the current review in
[`sei-protocol/uci`](https://github.com/sei-protocol/uci) without changing it.

## Layout

| Path | What it is |
|---|---|
| `src/verdict.ts` | The review contract: the `submit_review` schema, and how a submission becomes the recorded decision, check conclusion, placeable findings and thread plan. |
| `src/accepted.ts` | The base branch's accepted pre-existing conditions, read from its guidelines. |
| `test/` | Tests, ported from the current review driver's. |
| `chart/` | The Helm chart for the service, published to `oci://ghcr.io/sei-protocol/charts` with the image. |

## Approval

With `approve-on-success`, a clean review approves when the pull request's author is on the
team, for the reviews a push, opening or turning ready starts, or when a team member asked for
the review by commenting `@seidroid review`. A review an allowed bot asks for, or one of an
allowed bot's pull request that no team member asked for, posts as a comment. Callers that also
set `require-verified-commits: true` get an approval only when every commit on the pull request
since the App's last approval there carries a signature GitHub verified, committed by a team
member. Callers that do not send it, such as v0.3.4, approve as if it were off.

## Development

Node 24 runs the TypeScript directly, so there is no build step.

```sh
npm ci
npm run typecheck
npm test
```
