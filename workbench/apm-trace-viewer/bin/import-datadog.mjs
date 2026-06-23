#!/usr/bin/env node
// Import APM spans from the Datadog Spans API into a viewer dataset.
//
//   DD_API_KEY=… DD_APP_KEY=… node bin/import-datadog.mjs --query '<spans query>' [options]
//     --query <q>        Datadog spans search query (e.g. 'service:flora-web @workflow.run.id:wrun_…')
//     --from <t>         start of window: ISO, epoch ms, or relative ('now-1h'). default now-1h
//     --to <t>           end of window. default now
//     --dataset <id>     dataset id (default: 'datadog')
//     --title <str>      landing-page title (default: dataset id)
//     --group-by <key>   group spans into "runs" by 'trace_id' (default) or a tag key
//                        (e.g. @workflow.run.id) read from each span's custom attributes
//     --site <site>      Datadog site (default: $DD_SITE or datadoghq.com)
//     --limit <n>        page size (default 1000)
//     --max <n>          stop after this many spans (default 20000)
//     --debug-first      print the first raw span and exit (to inspect field names)
//     --input <file>     skip the network and map a saved Spans API payload instead —
//                        a JSON file holding `{data:[...]}` or an array of such pages.
//                        Lets you re-import offline or via another auth path, e.g.
//                        `pup --no-agent traces search … > spans.json` then `--input spans.json`.
//     --out <dir>        viewer data dir (default: ../viewer/data)
//
// Auth (network mode): DD_API_KEY (DD-API-KEY) + DD_APP_KEY (DD-APPLICATION-KEY). The
// Spans search endpoint is rate-limited (300 req/hr); --limit 1000 keeps page count low.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildDataset, hostFromUrl, isoToEpochNs } from '../lib/normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '..', 'viewer', 'data');

const { values } = parseArgs({
  options: {
    query: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    dataset: { type: 'string' },
    title: { type: 'string' },
    'group-by': { type: 'string' },
    site: { type: 'string' },
    limit: { type: 'string' },
    max: { type: 'string' },
    'debug-first': { type: 'boolean' },
    input: { type: 'string' },
    out: { type: 'string' },
  },
});

const apiKey = process.env.DD_API_KEY;
const appKey = process.env.DD_APP_KEY;
if (!values.input && (!apiKey || !appKey)) {
  console.error(
    'error: set DD_API_KEY and DD_APP_KEY (or pass --input <saved-spans.json>).'
  );
  process.exit(1);
}

const site = values.site ?? process.env.DD_SITE ?? 'datadoghq.com';
const query = values.query ?? '*';
const from = values.from ?? 'now-1h';
const to = values.to ?? 'now';
const groupByTag =
  values['group-by'] && values['group-by'] !== 'trace_id'
    ? values['group-by']
    : null;
const pageLimit = Number(values.limit ?? 1000);
const maxSpans = Number(values.max ?? 20000);
const datasetId = (values.dataset ?? 'datadog').replace(/[^\w.-]+/g, '-');
const title = values.title ?? datasetId;
const out = values.out ?? DEFAULT_OUT;

const url = `https://api.${site}/api/v2/spans/events/search`;

async function fetchPage(cursor) {
  const body = {
    data: {
      type: 'search_request',
      attributes: {
        filter: { from: String(from), to: String(to), query },
        sort: 'timestamp',
        page: { limit: pageLimit, ...(cursor ? { cursor } : {}) },
      },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'DD-API-KEY': apiKey,
      'DD-APPLICATION-KEY': appKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Datadog API ${res.status} ${res.statusText}: ${text.slice(0, 400)}`
    );
  }
  return res.json();
}

// Read a custom-attribute value. The Spans API returns `attributes.custom` as a
// flat map with literal dotted keys (e.g. `custom["http.host"]`), but some tools
// render it as nested objects (`custom.http.host`). Try the flat key first, then
// walk the nested path, so the same parser handles both shapes.
function cv(custom, dotted) {
  if (custom == null) return undefined;
  if (dotted in custom) return custom[dotted];
  let node = custom;
  for (const part of dotted.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

// ---- map a Datadog span -> canonical input span ----
// DD span object: { id, attributes: { trace_id, span_id, parent_id, service,
// resource_name, operation_name, start_timestamp, end_timestamp, custom:{…}, tags:[…] } }.
// OTel-origin fields (scope, gen_ai.*, http.*) live under `custom`; the span's own
// duration is `custom.duration` in nanoseconds (top-level `duration` is null).
function mapSpan(raw) {
  const a = raw.attributes ?? {};
  const c = a.custom ?? {};
  const startNs = isoToEpochNs(a.start_timestamp);
  const customDur = cv(c, 'duration');
  const durNs =
    typeof customDur === 'number'
      ? customDur
      : Math.max(
          0,
          (a.end_timestamp ? isoToEpochNs(a.end_timestamp) : startNs) - startNs
        );
  const scope =
    cv(c, 'scope.name') ??
    cv(c, 'otel.scope.name') ??
    cv(c, 'otel.library.name') ??
    null;
  const kind = cv(c, 'span.kind') ?? a.type ?? null;
  const isHttp = kind === 'client' || scope === '@vercel/otel/fetch';
  const host = isHttp
    ? (cv(c, 'http.host') ??
      cv(c, 'net.peer.name') ??
      cv(c, 'network.peer.address') ??
      hostFromUrl(cv(c, 'http.url'), cv(c, 'url.full'), a.resource_name))
    : null;
  const groupTagVal = groupByTag
    ? (cv(c, groupByTag) ?? cv(c, groupByTag.replace(/^@/, '')))
    : null;
  return {
    group: groupTagVal ?? a.trace_id,
    id: a.span_id,
    parent: a.parent_id && a.parent_id !== '0' ? a.parent_id : null,
    trace: a.trace_id,
    name: a.resource_name ?? a.operation_name ?? raw.id,
    service: a.service ?? null,
    scope,
    kind,
    host,
    startNs,
    durNs,
    events: [],
    model:
      cv(c, 'gen_ai.request.model') ?? cv(c, 'gen_ai.response.model') ?? null,
    inTok: cv(c, 'gen_ai.usage.input_tokens') ?? null,
    outTok: cv(c, 'gen_ai.usage.output_tokens') ?? null,
    finish: cv(c, 'gen_ai.response.finish_reasons') ?? null,
    httpMethod: cv(c, 'http.request.method') ?? cv(c, 'http.method') ?? null,
    httpRoute: cv(c, 'http.route') ?? null,
    httpStatus:
      cv(c, 'http.response.status_code') ?? cv(c, 'http.status_code') ?? null,
    err: cv(c, 'error.type') ?? null,
    attrs: c,
  };
}

const spans = [];
let pages = 0;
if (values.input) {
  // Offline mode: map a saved Spans API payload ({data:[…]} or an array of pages).
  const parsed = JSON.parse(readFileSync(values.input, 'utf8'));
  const pageList = Array.isArray(parsed) ? parsed : [parsed];
  for (const page of pageList) {
    for (const raw of page.data ?? []) spans.push(mapSpan(raw));
    pages++;
  }
} else {
  let cursor = null;
  do {
    const json = await fetchPage(cursor);
    const data = json.data ?? [];
    if (values['debug-first']) {
      console.error(
        JSON.stringify(data[0] ?? { note: 'no spans returned' }, null, 2)
      );
      process.exit(0);
    }
    for (const raw of data) spans.push(mapSpan(raw));
    cursor = json.meta?.page?.after ?? null;
    pages++;
  } while (cursor && spans.length < maxSpans);
}

if (spans.length === 0) {
  console.error('no spans returned for that query/window.');
  process.exit(1);
}

const count = buildDataset({
  outDir: out,
  id: datasetId,
  title,
  source: 'datadog',
  spans,
});
console.log(
  `datadog → dataset "${datasetId}": ${count} trace group(s), ${spans.length} spans (${pages} page(s)) → ${join(out, datasetId)}`
);
