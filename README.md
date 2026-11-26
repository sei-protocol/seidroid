# seidroid

`seidroid[bot]` is Sei's AI reviewer for GitHub. This repository is the next generation of
its review: the same review contract, run in [pi](https://pi.dev) on the caller's GitHub
runner, with no session server, sandbox or teardown. One ref of this repository pins the
whole review.

It is in development, and runs beside the current review in
[`sei-protocol/uci`](https://github.com/sei-protocol/uci) without changing it.

## When it reviews

A pull request gets one review on its own, when it opens ready for review, turns ready or
reopens. After that, including after a change request, a team member or an allowed bot asks
for each review by commenting `@seidroid review`, unless the caller sets
`re-review-on-push: true`, which reviews every push.

## Layout

| Path | What it is |
|---|---|
| `src/verdict.ts` | The review contract: the `submit_review` schema, and how a submission becomes the recorded decision, check conclusion, placeable findings and thread plan. |
| `src/accepted.ts` | The base branch's accepted pre-existing conditions, read from its guidelines. |
| `test/` | Tests, ported from the current review driver's. |
| `chart/` | The Helm chart for the service, published to `oci://ghcr.io/sei-protocol/charts` with the image. |

## Development

Node 24 runs the TypeScript directly, so there is no build step.

```sh
npm ci
npm run typecheck
npm test
```
