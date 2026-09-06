#!/usr/bin/env node
// Import an Axiom OTel JSONL dump into a viewer dataset.
//
//   node bin/import-axiom.mjs <dir|file.jsonl> [options]
//     --dataset <id>        dataset id (default: input basename)
//     --title <str>         landing-page title (default: dataset id)
//     --group-by file|trace how to group spans into "runs": one per file (default for a
//                           directory) or one per trace_id (default for a single file)
//     --metrics <csv>       supplied per-run metrics keyed by runId/id; rendered as chips
//     --markers <a,b,...>   metric columns (ms offsets from run start) to draw as vertical
//                           lines, e.g. --markers ttftMs,firstChunkMs
//     --out <dir>           viewer data dir (default: ../viewer/data)
//
// Axiom rows are flat OTel records: trace_id, span_id, parent_span_id, name, kind,
// _time (ISO), duration (Go string), service.name, scope.name, events[], attributes.*.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildDataset,
  goDurationToNs,
  hostFromUrl,
  isoToEpochNs,
  parseCsv,
} from '../lib/normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '..', 'viewer', 'data');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dataset: { type: 'string' },
    title: { type: 'string' },
    'group-by': { type: 'string' },
    metrics: { type: 'string' },
    markers: { type: 'string' },
    out: { type: 'string' },
  },
});

const input = positionals[0];
if (!input) {
  console.error(
    'usage: import-axiom.mjs <dir|file.jsonl> [--dataset id] [--group-by file|trace] [--metrics csv] [--markers a,b] [--out dir]'
  );
  process.exit(1);
}

const isDir = statSync(input).isDirectory();
const files = isDir
  ? readdirSync(input)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(input, f))
  : [input];
if (files.length === 0) {
  console.error(`no .jsonl files found in ${input}`);
  process.exit(1);
}

const groupBy = values['group-by'] ?? (isDir ? 'file' : 'trace');
const datasetId = (
  values.dataset ?? basename(input).replace(/\.jsonl$/, '')
).replace(/[^\w.-]+/g, '-');
const title = values.title ?? datasetId;
const out = values.out ?? DEFAULT_OUT;
const markerCols = new Set(
  (values.markers ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

// ---- optional metrics CSV (keyed by runId/id/first column) ----
const metricsByGroup = {};
if (values.metrics) {
  const rows = parseCsv(readFileSync(values.metrics, 'utf8'));
  const keyCol = rows.length
    ? (['runId', 'id', 'run'].find((k) => k in rows[0]) ??
      Object.keys(rows[0])[0])
    : null;
  for (const row of rows) {
    const gid = row[keyCol];
    if (!gid) continue;
    metricsByGroup[gid] = Object.entries(row)
      .filter(([k]) => k !== keyCol)
      .filter(([, v]) => v !== '' && v != null && v !== '?')
      .map(([key, raw]) => {
        const num = Number(raw);
        const value =
          Number.isFinite(num) && /^-?\d*\.?\d+$/.test(raw) ? num : raw;
        const m = { key, label: key, value };
        if (key.endsWith('Ms')) m.unit = 'ms';
        if (markerCols.has(key) && Number.isFinite(num)) m.markerOffsetMs = num;
        return m;
      });
  }
}

// ---- read + canonicalize spans ----
function collectAttrs(rec) {
  const attrs = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v == null) continue;
    if (k === 'attributes.custom' && typeof v === 'object')
      Object.assign(attrs, v);
    else if (k.startsWith('attributes.') && k !== 'attributes.custom')
      attrs[k.slice('attributes.'.length)] = v;
  }
  return attrs;
}

const spans = [];
for (const file of files) {
  const fileGroup = basename(file).replace(/\.jsonl$/, '');
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const scope = rec['scope.name'];
    const cust = rec['attributes.custom'] ?? {};
    const isHttp = rec.kind === 'client' || scope === '@vercel/otel/fetch';
    const host = isHttp
      ? (cust['http.host'] ??
        cust['net.peer.name'] ??
        hostFromUrl(
          rec['attributes.url.full'],
          cust['http.url'],
          cust['resource.name'],
          rec.name
        ))
      : null;
    spans.push({
      group: groupBy === 'trace' ? rec.trace_id : fileGroup,
      id: rec.span_id,
      parent: rec.parent_span_id,
      trace: rec.trace_id,
      name: rec.name,
      service: rec['service.name'],
      scope,
      kind: rec.kind,
      host,
      startNs: isoToEpochNs(rec._time),
      durNs: goDurationToNs(rec.duration),
      events: (rec.events ?? []).map((e) => ({
        name: e.name,
        tNs: typeof e.timestamp === 'number' ? e.timestamp : null,
      })),
      model:
        rec['attributes.gen_ai.request.model'] ??
        rec['attributes.gen_ai.response.model'] ??
        null,
      inTok: rec['attributes.gen_ai.usage.input_tokens'] ?? null,
      outTok: rec['attributes.gen_ai.usage.output_tokens'] ?? null,
      finish: rec['attributes.gen_ai.response.finish_reasons'] ?? null,
      httpMethod:
        rec['attributes.http.request.method'] ?? cust['http.method'] ?? null,
      httpRoute: rec['attributes.http.route'] ?? null,
      httpStatus: rec['attributes.http.response.status_code'] ?? null,
      err: rec['attributes.error.type'] ?? null,
      attrs: collectAttrs(rec),
    });
  }
}

const count = buildDataset({
  outDir: out,
  id: datasetId,
  title,
  source: 'axiom',
  spans,
  metricsByGroup,
});
console.log(
  `axiom → dataset "${datasetId}": ${count} trace group(s), ${spans.length} spans → ${join(out, datasetId)}`
);
