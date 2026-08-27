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

## Flame graph + STSO

Every trace group has a second view (`flame` on the landing page, or **flame graph** in
the waterfall's top bar): a Datadog-style flame graph, x = wall time, y = tree depth.
It exists to answer one question - where does **STSO** go?

**STSO** (step-to-step overhead) is the stretch between one step's **user code**
finishing and the next step's user code starting: the stream flushes, the
`step_completed` POST and its server-side work, `getNewEvents`, the `workflow.run`
replay, the `step_created` / `step_started` writes.

Which span you measure from matters. The SDK emits a nested pair per step - an outer
`step.execute <name>` and an inner unnamed `step.execute` - and only the inner one is the
user's own code. The outer also covers the SDK work bracketing it, most importantly the
blocking `step_completed` POST at its tail (61-495ms on the traces this was built
against). STSO is measured between **inner** spans so that POST falls inside the gap
where you can see it, instead of hiding inside the previous step's bar; on the reference
run that is the difference between a p50 of 109ms and the real 381ms. In the graph those
user-code frames are outlined and labelled `<step> (user code)`, taking the name from
their outer parent since the inner span carries none.

An outer span with no inner child is a **replay**: the invocation re-created the step
span, wrote `step_started`, found the step already done and ran no user code. Those are
excluded - they are not a step boundary - and the sidebar says how many were skipped. The left sidebar lists every gap in the run, sortable **by time** or **by size**,
with p50 / p90 / total across the run. Click one and the graph zooms to it (padded so the
two bracketing steps stay visible), the gap is shaded, and the panel underneath rolls up
what ran inside it by **self time** - time not covered by a child, which is the row
actually costing you. `[` and `]` step between gaps; `?gap=N` deep-links to one.

Two details keep the numbers honest. Steps that run in parallel (`Promise.all`) are
merged into one cluster first, so a gap always means "no step body was running" rather
than a meaningless negative from subtracting overlapping spans. And gaps are computed
per trace, because a boundary between traces is a durable suspend/resume, not overhead.

Navigating it: **scroll to zoom** at the pointer, **shift-scroll** (or a horizontal
trackpad swipe) to pan, **alt-scroll** to fall through to native vertical scrolling on
traces deep enough to overflow. Double-click a frame to zoom to it, drag across the ruler
to select a range, breadcrumbs and `Esc` to go back, click a frame for its attributes.
Wheel gestures deliberately do not push breadcrumbs - a crumb per notch would bury the
gap and span entries worth stepping back to.

### Reparenting WebSocket spans

When the SDK ships events over the WS transport it synthesizes one client `http POST`
span per frame, but a frame carries no W3C traceparent - only the handshake does. So the
server-side write for every frame parents to the long-lived handshake span instead of to
the frame that caused it. The trace is still connected, but per-frame correlation is
gone: server work piles up under the connection, and (when the handshake span itself is
missing from the window) some server spans have no parent at all.

**reparent WS spans**, on by default in both views, reconstructs the pairing. Client
frames carry `workflow.event.type` and server event spans `workflow.event_type`; within
one trace both sides see the same event sequence in the same order, so they are bucketed
by (trace, type) and paired in order, admitting a pair only when the server span starts
inside the frame's window allowing for cross-host clock skew. Anything that fails the
check is left alone rather than guessed at, and the control shows how many of the
candidates were matched. Reparented spans carry a cyan underline in the flame graph.

This is a **display-time** correction: it never touches the imported data, and toggling
it off restores exactly what the vendor sent.

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

#### Fetching with pup (no API keys)

If you use [pup](https://github.com/DataDog/pup), its OAuth session works without
provisioning keys. Note `pup traces search` caps out at `--limit 1000` and exposes no
cursor, so it silently truncates anything bigger; page the Spans API yourself through
pup's raw-request escape hatch and feed the result to `--input`, which accepts an array
of pages:

```bash
pup --no-agent api -X POST v2/spans/events/search --input - <<'JSON'
{"data":{"type":"search_request","attributes":{
  "filter":{"from":"2026-08-27T18:00:00Z","to":"2026-08-27T19:00:00Z","query":"trace_id:<id>"},
  "sort":"timestamp","page":{"limit":1000}}}}
JSON
```

Follow `meta.page.after` for the next cursor. To view a whole run this way, first find
its traces with `@workflow.run.id:<runId>`, then fetch `trace_id:A OR trace_id:B ...` and
import with `--input pages.json --group <runId>`.

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
viewer/             static app: index/run/flame .html + .js, app.css + flame.css
viewer/common.js    presentation helpers (category, color, formatting)
viewer/analysis.js  trace reshaping: WS reparenting, tree/depth, STSO gaps, window rollup
fixtures/           tiny synthetic sample trace (the only trace data in git)
viewer/data/        generated datasets — GIT-IGNORED (may contain customer/production data)
```

> ⚠️ **Never commit real trace data.** `viewer/data/` (and `raw/`, `*.tar.gz`, non-fixture
> `*.jsonl`) are git-ignored on purpose — imported traces can contain customer URLs,
> deployment ids, tokens, etc. Only the tool and the synthetic fixture are tracked.
