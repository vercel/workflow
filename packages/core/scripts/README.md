# Compression benchmarks

These benchmarks measure the gzip payload compression feature
(specVersion 5, PR adding the `gzip` serialization format prefix). The benchmarks
measure two dimensions: **storage size** (bytes saved) and **CPU cost**
(time added to serialize/deserialize). Both benchmarks use the shared,
deterministic workloads in `lib/workloads.mjs`.

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

The script prints the exact bytes the serialization layer hands to the World storage
backends (S3/DynamoDB refs for Vercel, `bytea` columns for Postgres, JSON
files for local), compression off vs on, per workload, plus a simulated
10-step AI-agent event-log total. Backends that base64-encode binary
(DynamoDB inline refs, world-local JSON) see approximately 33% larger absolute
savings
than the raw numbers.

## 2. CPU cost

```bash
node scripts/benchmark-compression-cpu.mjs
```

Three sections:

1. **Per-payload serialize + deserialize cost** through the real shipping
   path (`step.serialize` / `step.deserialize`, which use the Web
   `CompressionStream('gzip')`), off vs on, with throughput.
2. **Stress**: Total serialization CPU to write and replay-read thousands
   of event payloads, modeling a long workflow.
3. **Algorithm comparison** (`node:zlib` sync): Gzip levels 1/6/9,
   Brotli, and deflate-raw. This comparison evaluates candidate codecs for a
   future format prefix (e.g. a `zsd1` zstd codec). Not the shipping path.

Compression is a **world-independent CPU cost** added to the
serialize/deserialize path. The world only changes the *baseline* you
compare against: local (filesystem) is the fastest baseline so the
relative impact is largest there; Vercel (network + AES encryption + S3)
has the slowest baseline so the relative impact is smallest. The absolute
microbenchmark numbers hold for every backend.

## 3. End-to-end runtime (local + Vercel)

The end-to-end benchmark runner (`packages/core/e2e/benchmark.test.ts`)
drives the scenario workflows in
`workbench/example/workflows/97_bench.ts` through a real World and records
core latency metrics, including TTFS (time to first step), STSO (step-to-step
overhead), WO (workflow overhead), and SL (stream latency). The runner reports
`avg`/`p50`/`p90`/`p99` and writes them to `bench-results-<app>-<backend>.json`.
It requires `DEPLOYMENT_URL` (the running app) and `APP_NAME` (used in the
output filename). You can tune iteration counts via `BENCH_*` env vars (see
the file header).

```bash
# Local World (nextjs-turbopack dev server on :3000)
cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 pnpm dev &
# From repo root
DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack pnpm bench
```

To measure the compression delta, run the harness twice and diff the
output JSON: once normally (compression on, specVersion 5) and once with
`WORKFLOW_DISABLE_COMPRESSION=1` set on **both** the dev server and the
bench runner (compression off, everything else identical):

```bash
# Compression-off baseline
WORKFLOW_DISABLE_COMPRESSION=1 pnpm dev &          # in the workbench
# From repo root
WORKFLOW_DISABLE_COMPRESSION=1 \
  DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack pnpm bench
mv bench-results-nextjs-turbopack-local.json bench-results-...-off.json
```

For **Vercel**, the same runner targets a deployment when you set the Vercel env
vars from `CLAUDE.md` (`WORKFLOW_VERCEL_ENV`, `VERCEL_DEPLOYMENT_ID`,
`WORKFLOW_VERCEL_AUTH_TOKEN`, `WORKFLOW_VERCEL_PROJECT`, `VERCEL_OIDC_TOKEN`,
etc.). The runner detects the backend as `vercel` and writes
`bench-results-<app>-vercel.json`. Set the `WORKFLOW_DISABLE_COMPRESSION=1` kill
switch on the deployment (an env var on the Vercel project) for
the off baseline, since compression runs server-side in the step/workflow
handlers there.
