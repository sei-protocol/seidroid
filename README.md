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

## Development

Node 24 runs the TypeScript directly, so there is no build step.

```sh
npm ci
npm run typecheck
npm test
```
