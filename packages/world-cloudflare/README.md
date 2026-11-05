# @workflow/world-cloudflare

> **Experimental.** The API, the storage layout and the required Worker
> configuration may change between 0.x releases, and data written by one 0.x
> release may not be readable by the next.

A [Workflow SDK](https://workflow-sdk.dev) World for Cloudflare Workers. Each
workflow run is one Durable Object: the object stores the run's event log in
its SQLite storage and runs the workflow itself. Queue messages become signals
to that object, delays and sleeps become Durable Object alarms, and nothing
else (no Queues, KV or D1) is needed.

## How it works

| Piece | Durable Object / entrypoint | File |
| --- | --- | --- |
| Event log, run state, signals, alarms, `invoke` | `RunObject`, one per run | `src/run-object.ts` |
| Hook token ownership | `TokenObject`, one per token | `src/token-object.ts` |
| Streams | `StreamObject`, one per stream | `src/stream-object.ts` |
| Steps beyond core's inline limit | `StepRunner` (a `WorkerEntrypoint`) | `src/step-runner.ts` |
| World client: routes each call to its object | — | `src/world.ts` |

- **One writer per run.** Each `events.create` runs inside the run's object.
  Event semantics come from the Workflow SDK's in-memory reference store, and
  each committed event is written to the object's SQLite storage before the
  call returns. A cold object rebuilds its state from that log.
- **Single runner per run.** Deliveries for a run execute one at a time in its
  object, so the World declares the `invoke` capability.
- **Timers.** Delays and wait deadlines are alarms. The object writes
  `wait_completed` itself at the deadline, so `Promise.race([step(), sleep()])`
  resolves even while a step runs inline.
- **Crash recovery.** A delivery interrupted by a crash or a deploy is
  redelivered with the next attempt number.
- **Hooks.** A token is owned by one `TokenObject`, so two runs can never hold
  the same token. A claim against a token held by another run asks that run
  whether its hook is still live.
- **VM snapshots** (`experimental_snapshots`) are stored next to the event log,
  so a waiting run resumes from its QuickJS snapshot instead of replaying.
- **Encryption.** Each run's key is derived with HKDF-SHA256 from the
  `WORKFLOW_ENCRYPTION_SECRET` secret and the run id.
- **Deployment pinning.** A run records the build that created it and only
  executes on that build. Signals for it are held, not dropped, until that
  build serves the object again.

## Setup

### 1. Build your workflows

The Worker imports workflows compiled by the Workflow SDK builder. Run this
before `wrangler dev` or `wrangler deploy`:

```js
// build-workflows.mjs
import { buildCloudflareWorkflows } from '@workflow/world-cloudflare/build';

await buildCloudflareWorkflows({ cwd: process.cwd(), dirs: ['workflows'] });
```

It writes `.workflow/combined.mjs` (the workflow route) and
`.workflow/build-info.mjs` (`deploymentId` and a map of workflow ids).

### 2. Wire the World into your Worker

```ts
// worker.ts
import encoding from 'quickjs-wasi/encoding.so';
import headers from 'quickjs-wasi/headers.so';
import quickjs from 'quickjs-wasi/quickjs.wasm';
import structuredClone from 'quickjs-wasi/structured-clone.so';
import url from 'quickjs-wasi/url.so';
import { start } from 'workflow/api';
import { setWorld } from 'workflow/runtime';
import { setupCloudflareWorld } from '@workflow/world-cloudflare';
import { deploymentId, workflowIds } from './.workflow/build-info.mjs';
import { createFlowRoute } from './.workflow/combined.mjs';

export {
  RunObject,
  StepRunner,
  StreamObject,
  TokenObject,
} from '@workflow/world-cloudflare';

setupCloudflareWorld({
  deploymentId,
  createFlowRoute,
  quickjs: { quickjs, encoding, headers, url, structuredClone },
  setWorld,
});

export default {
  async fetch(request: Request) {
    const run = await start({ workflowId: workflowIds.myWorkflow }, []);
    return Response.json({ runId: run.runId });
  },
};
```

`quickjs-wasi` must be the release your `@workflow/core` depends on. The
package's type declarations reference `cloudflare:workers`, which a Worker
project gets from `wrangler types` or `@cloudflare/workers-types`.

### 3. Configure Wrangler

```jsonc
// wrangler.jsonc
{
  "main": "worker.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    // Workers have no node:vm; workflows run in the QuickJS engine.
    "WORKFLOW_VM": "quickjs",
    // workerd's node:zlib zstd fails on large inputs; use gzip.
    "WORKFLOW_COMPRESSION_CODEC": "gzip"
  },
  "durable_objects": {
    "bindings": [
      { "name": "WORKFLOW_RUNS", "class_name": "RunObject" },
      { "name": "WORKFLOW_TOKENS", "class_name": "TokenObject" },
      { "name": "WORKFLOW_STREAMS", "class_name": "StreamObject" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RunObject", "TokenObject", "StreamObject"] }
  ],
  // QuickJS native extensions ship as `.so` WebAssembly modules.
  "rules": [{ "type": "CompiledWasm", "globs": ["**/*.so"], "fallthrough": true }]
}
```

Set the encryption secret (32 random bytes, base64) with
`wrangler secret put WORKFLOW_ENCRYPTION_SECRET`. Without it, runs are not
encrypted and the QuickJS VM is not snapshotted.

The binding and class names above are required. With a compatibility date
before 2026-09-01, also add the `enable_ctx_exports` flag.

## Limitations

- `runs.list` and `hooks.list` without a `runId` are not implemented, so
  observability tools that list every run (the web UI, `workflow inspect`
  without a run id) do not work yet.
- Spec version 8 only. `createBatch`, hook retention, hook resume dedup and
  hook force claim are not declared, so the runtime uses its fallbacks.
- Workflows always run in the QuickJS engine (`WORKFLOW_VM=quickjs`).
- A run executes only on the build that created it. Runs started on an older
  build wait until that build serves them again.

## Development

```sh
pnpm --filter @workflow/world-cloudflare build
pnpm --filter @workflow/world-cloudflare test       # unit tests (src/**/*.test.ts)
pnpm --filter @workflow/world-cloudflare test:e2e   # end-to-end suite under wrangler dev
pnpm --filter @workflow/world-cloudflare e2e:dev    # the e2e Worker on :8787
```

The e2e suite (`e2e/test/e2e.test.ts`) builds the Worker in `e2e/` against the
built package and runs it under local `wrangler dev` (workerd with local
Durable Object storage); nothing is deployed. It covers sequential steps,
fan-out, sleep, `Promise.race` in both directions, retries, streams, hook
resume and cross-run token conflicts, a hook delivered during an inline step,
the health check, VM snapshots, and crash recovery by killing workerd mid-sleep
and mid-step. CI runs it in the `E2E Cloudflare (workerd)` job.
