# apm-trace-viewer

A tiny, dependency-free browser **waterfall viewer for OpenTelemetry APM traces**, with
first-class isolation of **Vercel Workflow** traffic (calls to `vercel-workflow.com` /
`vercel-queue.com`) from everything else. Point it at traces from any source — it ships
with importers for **Axiom** JSONL dumps and the **Datadog** Spans API, and the viewer
itself is source-agnostic.

It's a debugging tool (no build step, no framework, no deps — just Node + static files),
handy for investigating first-step latency / TTFT, polling volume, and where time goes in
a `DurableAgent` run.

## Quick start

```bash
# 1. Import some traces into a dataset (writes viewer/data/<dataset>/, git-ignored):
pnpm import:axiom fixtures/sample-otel.jsonl --dataset sample --group-by file \
  --metrics fixtures/sample-metrics.csv --markers ttftMs,firstChunkMs

# 2. Serve + open:
pnpm serve            # → http://localhost:8777/
```

The landing page lists datasets; pick one to see its traces; click a trace for the
waterfall. (Run from `workbench/apm-trace-viewer/`, or `pnpm --filter workflow-apm-trace-viewer <script>`.)

## In the viewer

- **Ours vs theirs.** Outbound HTTP is classified by destination host: `vercel-workflow.com`
  / `vercel-queue.com` → **workflow HTTP** (cyan); `scope=workflow` SDK spans → **workflow SDK**
  (blue); `scope=ai` model calls → **ai** (pink, with model + token counts inline);
  everything else → dimmed **3rd-party HTTP** (grey) or a stable hashed color per service.
- **group 3rd-party HTTP** (default on) collapses consecutive third-party spans into one
  expandable row so workflow traffic stands out — nothing is hidden, just compressed.
- **only ours (workflow + AI)** hides everything except workflow + AI.
- **Markers**: any supplied metric with a ms offset (e.g. TTFT, first chunk) draws a
  vertical line; the hover crosshair shows a live timestamp; zoom (±) for dense regions;
  click any span for full attributes + events.

## Importers

### Axiom (JSONL dump)

```bash
pnpm import:axiom <dir|file.jsonl> [--dataset id] [--title str] \
  [--group-by file|trace] [--metrics input.csv] [--markers ttftMs,firstChunkMs]
```

Axiom rows are flat OTel records. A **directory** groups one "run" per file (default);
a single file groups one run per `trace_id`. `--metrics` is a CSV keyed by `runId`/`id`;
each column becomes a chip, and columns named in `--markers` (ms offsets from run start)
also draw a vertical line. To import a `.tar.gz`, extract it first and point at the
directory of `.jsonl` files.

### Datadog (Spans API)

Auth comes from your own Datadog [API key + application key](https://docs.datadoghq.com/account_management/api-app-keys/):

```bash
export DD_API_KEY=…  DD_APP_KEY=…  DD_SITE=datadoghq.com   # DD_SITE per your org
```

The importer pages `POST /api/v2/spans/events/search` (rate-limited to 300 req/hr;
`--limit 1000` keeps page count low) and groups by `trace_id` by default, or by a custom
tag. `--debug-first` prints the first raw span and exits, for inspecting field names.

#### View one workflow run (recommended)

A single workflow run produces **several traces** — the request that *starts* it, plus one
per execution invocation — so to see the whole run you want all of them on a shared
timeline. `--run <runId>` does that in one step:

```bash
pnpm import:datadog --run wrun_… --from <start> --to <end>
pnpm serve
```

It searches for the run's spans by the OTel tag the Workflow SDK emits for the run id
(`workflow.run.id`, i.e. `@workflow.run.id:<runId>` in Datadog query syntax — override with
`--run-tag`), collects every trace that carries it, fetches all of their spans, and folds
them into a single group keyed by the run id. In the viewer that shows one entry with a
**trace-head per trace** (start trace, execution trace(s)) on one timeline. `--from`/`--to`
accept ISO, epoch ms, or relative (`now-1h`); widen the window if a run is long-lived.

#### Arbitrary query

```bash
pnpm import:datadog --query '<spans query>' --from now-1h --to now \
  [--dataset id] [--group-by trace_id|<tag>] [--group <id>]
```

`--group-by` splits into one run per `trace_id` (default) or per tag value; `--group <id>`
forces *everything* into a single group (handy when you've already narrowed to a set of
correlated trace_ids).

#### Offline / alternate fetch

`--input <file>` imports a saved Spans API payload instead of calling the network — a JSON
file holding `{ "data": [...] }` (or an array of such pages), however you obtained it
(e.g. a `curl` against the Spans API, or any other client). No keys required for the import
step:

```bash
pnpm import:datadog --input spans.json --dataset mytrace [--group <runId>]
```

## Adding a source / labeling vendors

- New source → add `bin/import-<source>.mjs` that turns the source's rows into the
  **canonical input span** documented at the top of `lib/normalize.mjs`, then calls
  `buildDataset(...)`. The viewer needs no changes.
- To label more third-party hosts (or relabel), edit the `VENDORS` list in
  `lib/normalize.mjs` and re-import. Unknown hosts fall back to the bare hostname.

## Layout

```
lib/normalize.mjs   shared: duration/timestamp parsing, host classification, dataset writer
bin/import-axiom.mjs, bin/import-datadog.mjs, bin/serve.mjs
viewer/             static app (index.html + run.html + common.js/index.js/run.js + app.css)
fixtures/           tiny synthetic sample trace (the only trace data in git)
viewer/data/        generated datasets — GIT-IGNORED (may contain customer/production data)
```

> ⚠️ **Never commit real trace data.** `viewer/data/` (and `raw/`, `*.tar.gz`, non-fixture
> `*.jsonl`) are git-ignored on purpose — imported traces can contain customer URLs,
> deployment ids, tokens, etc. Only the tool and the synthetic fixture are tracked.
