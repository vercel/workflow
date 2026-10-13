# @workflow/world-cloudflare (proof of concept)

> **Private, experimental.** Not published.

A World where each workflow run is one Cloudflare Durable Object. The object
stores the run's event log and runs the workflow itself. `queue()` messages
are signals telling the object to run it, and delays are alarms. Step bodies
run inline (up to core's inline limit) or in a separate `StepRunner`
invocation, and their results come back to the run object over RPC.

| Piece | File |
| --- | --- |
| World client (routes calls to objects; in-process inside one) | `src/world.ts` |
| Run object: event log, signals, alarms, `invoke` | `src/run-object.ts` |
| Hook token ownership and hook index | `src/token-object.ts` |
| Streams | `src/stream-object.ts` |
| Step execution outside the run object | `src/step-runner.ts` |
| In-process delivery to the workflow route | `src/runtime.ts` |

Event semantics come from `@workflow/world-sim`'s store, the in-memory
reference implementation of the World event contract. The run object persists
each committed event in its SQLite-backed storage and rebuilds the store from
that log on a cold start.

## Running locally

```sh
pnpm --filter @workflow/world-cloudflare poc:dev    # wrangler dev on :8787
pnpm --filter @workflow/world-cloudflare test:poc   # end-to-end tests under wrangler dev
```

Wrangler is run through `npx` (pinned in `package.json` scripts and
`poc/test/wrangler.ts`). Only local `workerd` is used; nothing is deployed.

`poc/build.mjs` compiles `poc/workflows/` with the SDK builder. The deployment
id it prints identifies that build, and runs are pinned to it.
