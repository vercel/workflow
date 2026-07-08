# Compression benchmarks

Reproducible benchmarks for the gzip payload compression feature
(specVersion 5, PR adding the `gzip` serialization format prefix). Two
dimensions are measured: **storage size** (bytes saved) and **CPU cost**
(time added to serialize/deserialize). All workloads are shared and
deterministic — see `lib/workloads.mjs`.

Build `@workflow/core` first so the scripts can import the compiled
serialization layer:

```bash
pnpm --filter @workflow/core build
cd packages/core
```

## 1. Storage size

```bash
node scripts/benchmark-compression-size.mjs
```

Prints the exact bytes the serialization layer hands to the World storage
backends (S3/DynamoDB refs for vercel, `bytea` columns for postgres, JSON
files for local), compression off vs on, per workload, plus a simulated
10-step AI-agent event-log total. Backends that base64-encode binary
(DynamoDB inline refs, world-local JSON) see ~33% larger absolute savings
than the raw numbers.

## 2. CPU cost

```bash
node scripts/benchmark-compression-cpu.mjs
```

Three sections:

1. **Per-payload serialize + deserialize cost** through the real shipping
   path (`step.serialize` / `step.deserialize`, which use the Web
   `CompressionStream('gzip')`), off vs on, with throughput.
2. **Stress** — total serialization CPU to write + replay-read thousands
   of event payloads, modelling a long workflow.
3. **Algorithm comparison** (`node:zlib` sync) — gzip levels 1/6/9,
   brotli, deflate-raw — informational, to compare candidate codecs for a
   future format prefix (e.g. a `zsd1` zstd codec). Not the shipping path.

Compression is a **world-independent CPU cost** added to the
serialize/deserialize path. The world only changes the *baseline* you
compare against: local (filesystem) is the fastest baseline so the
relative impact is largest there; Vercel (network + AES encryption + S3)
has the slowest baseline so the relative impact is smallest. The absolute
microbenchmark numbers hold for every backend.

## 3. End-to-end runtime (local + vercel)

The end-to-end benchmark runner (`packages/core/e2e/benchmark.test.ts`)
drives the scenario workflows in
`workbench/example/workflows/97_bench.ts` through a real World and records
core latency metrics — TTFS (time to first step), STSO (step-to-step
overhead), WO (workflow overhead), and SL (stream latency) — reported as
`avg`/`p50`/`p90`/`p99` and written to `bench-results-<app>-<backend>.json`.
It requires `DEPLOYMENT_URL` (the running app) and `APP_NAME` (used in the
output filename). Iteration counts are tunable via `BENCH_*` env vars (see
the file header).

```bash
# Local world (nextjs-turbopack dev server on :3000)
cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 pnpm dev &
# from repo root
DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack pnpm bench
```

To measure the compression delta, run the harness twice and diff the
output JSON: once normally (compression on, specVersion 5) and once with
`WORKFLOW_DISABLE_COMPRESSION=1` set on **both** the dev server and the
bench runner (compression off, everything else identical):

```bash
# compression OFF baseline
WORKFLOW_DISABLE_COMPRESSION=1 pnpm dev &          # in the workbench
# from repo root
WORKFLOW_DISABLE_COMPRESSION=1 \
  DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack pnpm bench
mv bench-results-nextjs-turbopack-local.json bench-results-...-off.json
```

For **Vercel**, the same runner targets a deployment when the Vercel env
vars from `CLAUDE.md` are set (`WORKFLOW_VERCEL_ENV`, `VERCEL_DEPLOYMENT_ID`,
`WORKFLOW_VERCEL_AUTH_TOKEN`, `WORKFLOW_VERCEL_PROJECT`, `VERCEL_OIDC_TOKEN`,
etc.); the backend is then detected as `vercel` and it writes
`bench-results-<app>-vercel.json`. The `WORKFLOW_DISABLE_COMPRESSION=1` kill
switch must be set on the deployment (an env var on the Vercel project) for
the off baseline, since compression runs server-side in the step/workflow
handlers there.
