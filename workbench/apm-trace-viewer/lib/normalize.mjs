// Shared normalization for every importer. Each importer turns its source's raw
// spans into "canonical input spans" (below) and hands them to `buildDataset`,
// which computes per-trace-group relative timings, classifies HTTP origin, and
// writes the normalized JSON the static viewer consumes. The viewer never knows
// which source produced a dataset.
//
// Canonical input span (what an importer passes in `spans`):
//   { group, id, parent, trace, name, service, scope, kind,
//     host,            // outbound destination host (client/fetch spans only), else null
//     startNs, durNs,  // epoch ns (Number; ms-scale precision is plenty for a waterfall)
//     events: [{ name, tNs }],   // tNs = absolute epoch ns, or null
//     model, inTok, outTok, finish, httpMethod, httpRoute, httpStatus, err,
//     attrs }          // flat string->value map shown in the detail drawer
//
// `group` is the id of the trace-group (a "run") the span belongs to — one group
// may span multiple OTel trace_ids (e.g. a workflow run's edge + serverless traces).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- Go duration string -> nanoseconds (e.g. "35.5s", "1.2ms", "1m2.5s") ----
const UNIT_NS = {
  ns: 1,
  us: 1e3,
  µs: 1e3,
  μs: 1e3,
  ms: 1e6,
  s: 1e9,
  m: 60e9,
  h: 3600e9,
};
const DUR_RE = /([0-9]*\.?[0-9]+)(ns|µs|μs|us|ms|s|m|h)/g;

export function goDurationToNs(str) {
  if (str == null) return 0;
  const s = String(str).trim();
  if (s === '' || s === '0' || s === '0s') return 0;
  let total = 0;
  let matched = false;
  for (const [, value, unit] of s.matchAll(DUR_RE)) {
    matched = true;
    total += Number.parseFloat(value) * UNIT_NS[unit];
  }
  if (!matched) {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n * 1e9 : 0; // bare number: assume seconds
  }
  return total;
}

// ---- ISO-8601 (optional nanosecond fraction) -> epoch nanoseconds ----
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

export function isoToEpochNs(iso) {
  const m = TS_RE.exec(iso);
  if (!m) throw new Error(`unparseable timestamp: ${iso}`);
  const [, y, mo, d, h, mi, se, frac] = m;
  const baseMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const fracNs = frac ? Number(`${frac}000000000`.slice(0, 9)) : 0;
  return baseMs * 1e6 + fracNs;
}

export function nsToIso(ns) {
  return new Date(Math.round(ns / 1e6)).toISOString();
}

// ---- outbound HTTP host classification (ours vs theirs) ----
// vercel-workflow.com / vercel-queue.com are Vercel Workflow infrastructure — "ours".
// Extend VENDORS to label more third parties; unknown hosts fall back to the bare host.
const VENDORS = [
  ['vercel-workflow.com', 'workflow'],
  ['vercel-queue.com', 'queue'],
  ['convex.cloud', 'convex'],
  ['convex.site', 'convex'],
  ['axiom.co', 'axiom'],
  ['braintrust.dev', 'braintrust'],
  ['braintrustdata.com', 'braintrust'],
  ['openai.com', 'openai'],
  ['anthropic.com', 'anthropic'],
  ['raindrop.ai', 'raindrop'],
  ['upstash.io', 'upstash'],
  ['clerk.com', 'clerk'],
  ['clerk.dev', 'clerk'],
  ['posthog.com', 'posthog'],
  ['liveblocks.io', 'liveblocks'],
];

export function isWorkflowHost(host) {
  return (
    host === 'vercel-workflow.com' ||
    host.endsWith('.vercel-workflow.com') ||
    host === 'vercel-queue.com' ||
    host.endsWith('.vercel-queue.com')
  );
}

export function vendorOf(host) {
  for (const [needle, label] of VENDORS) {
    if (host.includes(needle)) return label;
  }
  if (
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host.startsWith('127.0.0.1')
  ) {
    return 'localhost';
  }
  return host;
}

export function classifyHttp(host) {
  if (!host) return { vendor: null, httpOrigin: null };
  return {
    vendor: vendorOf(host),
    httpOrigin: isWorkflowHost(host) ? 'workflow' : 'third-party',
  };
}

// ---- host extracted from a URL (shared by importers) ----
const URL_HOST_RE = /https?:\/\/([^/\s?]+)/;
export function hostFromUrl(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const m = URL_HOST_RE.exec(String(c));
    if (m) return m[1];
  }
  return null;
}

// ---- minimal CSV parser (quoted fields, returns rows keyed by header) ----
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    rows.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') pushRecord();
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || record.length) pushRecord();
  const [header, ...body] = rows.filter(
    (r) => r.length > 1 || (r.length === 1 && r[0] !== '')
  );
  if (!header) return [];
  return body.map((r) =>
    Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? '']))
  );
}

const round = (n) => Math.round(n * 1e4) / 1e4;
const topService = (counts) =>
  [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

/**
 * Group canonical spans into trace-groups, compute relative timings + counts, and
 * write data/<id>/{index.json,runs/*.json} plus register the dataset in datasets.json.
 *
 * @param {object} o
 * @param {string} o.outDir  - the viewer's data dir
 * @param {string} o.id      - dataset id (url-safe)
 * @param {string} o.title   - human title for the landing page
 * @param {string} o.source  - 'axiom' | 'datadog' | ...
 * @param {Array}  o.spans   - canonical input spans (must carry `group`)
 * @param {object} [o.metricsByGroup] - { [group]: [{ key, label, value, unit?, markerOffsetMs? }] }
 * @param {object} [o.labelByGroup]   - { [group]: string }
 */
export function buildDataset({
  outDir,
  id,
  title,
  source,
  spans,
  metricsByGroup = {},
  labelByGroup = {},
}) {
  const groups = new Map();
  for (const s of spans) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }

  const datasetDir = join(outDir, id);
  mkdirSync(join(datasetDir, 'runs'), { recursive: true });

  const indexTraces = [];
  for (const [gid, gspans] of groups) {
    const originNs = Math.min(...gspans.map((s) => s.startNs));
    let maxEnd = 0;
    let wfHttp = 0;
    let tpHttp = 0;
    let aiCount = 0;
    const traceAgg = new Map();
    const out = [];

    for (const s of gspans) {
      const startMs = (s.startNs - originNs) / 1e6;
      const durMs = s.durNs / 1e6;
      maxEnd = Math.max(maxEnd, startMs + durMs);
      const { vendor, httpOrigin } = classifyHttp(s.host);
      if (httpOrigin === 'workflow') wfHttp++;
      else if (httpOrigin === 'third-party') tpHttp++;
      if (s.scope === 'ai' || s.model) aiCount++;

      out.push({
        id: s.id,
        parent: s.parent ?? null,
        trace: s.trace,
        name: s.name,
        service: s.service ?? null,
        scope: s.scope ?? null,
        kind: s.kind ?? null,
        host: s.host ?? null,
        vendor,
        httpOrigin,
        startMs: round(startMs),
        durMs: round(durMs),
        events: (s.events ?? []).map((e) => ({
          name: e.name,
          tMs: e.tNs == null ? null : round((e.tNs - originNs) / 1e6),
        })),
        model: s.model ?? null,
        inTok: s.inTok ?? null,
        outTok: s.outTok ?? null,
        finish: s.finish ?? null,
        httpMethod: s.httpMethod ?? null,
        httpRoute: s.httpRoute ?? null,
        httpStatus: s.httpStatus ?? null,
        err: s.err ?? null,
        attrs: s.attrs ?? {},
      });

      if (!traceAgg.has(s.trace)) {
        traceAgg.set(s.trace, {
          traceId: s.trace,
          count: 0,
          services: new Map(),
          startMs,
          rootId: null,
        });
      }
      const t = traceAgg.get(s.trace);
      t.count++;
      t.services.set(s.service, (t.services.get(s.service) || 0) + 1);
      t.startMs = Math.min(t.startMs, startMs);
      if (!s.parent) t.rootId = s.id;
    }

    const traces = [...traceAgg.values()]
      .sort((a, b) => a.startMs - b.startMs)
      .map((t) => ({
        traceId: t.traceId,
        count: t.count,
        rootId: t.rootId,
        startMs: round(t.startMs),
        service: topService(t.services),
      }));

    const metrics = metricsByGroup[gid] ?? [];
    const run = {
      id: gid,
      label: labelByGroup[gid] ?? gid,
      source,
      originIso: nsToIso(originNs),
      totalMs: round(maxEnd),
      spanCount: gspans.length,
      aiSpanCount: aiCount,
      workflowHttpCount: wfHttp,
      thirdPartyHttpCount: tpHttp,
      traces,
      metrics,
      spans: out,
    };
    writeFileSync(join(datasetDir, 'runs', `${gid}.json`), JSON.stringify(run));

    indexTraces.push({
      id: gid,
      label: run.label,
      spanCount: run.spanCount,
      wallMs: run.totalMs,
      originIso: run.originIso,
      workflowHttpCount: wfHttp,
      thirdPartyHttpCount: tpHttp,
      aiSpanCount: aiCount,
      metrics,
    });
  }

  indexTraces.sort((a, b) => a.label.localeCompare(b.label));
  writeFileSync(
    join(datasetDir, 'index.json'),
    `${JSON.stringify({ source, title, traces: indexTraces }, null, 2)}\n`
  );
  registerDataset(outDir, {
    id,
    title,
    source,
    traceCount: indexTraces.length,
    importedAt: new Date().toISOString(),
  });
  return indexTraces.length;
}

function registerDataset(outDir, entry) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'datasets.json');
  let datasets = [];
  if (existsSync(file)) {
    try {
      datasets = JSON.parse(readFileSync(file, 'utf8')).datasets ?? [];
    } catch {
      datasets = [];
    }
  }
  datasets = datasets.filter((d) => d.id !== entry.id);
  datasets.push(entry);
  datasets.sort((a, b) => a.title.localeCompare(b.title));
  writeFileSync(file, `${JSON.stringify({ datasets }, null, 2)}\n`);
}
