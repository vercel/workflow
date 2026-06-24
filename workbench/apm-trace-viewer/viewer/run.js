import {
  CAT_LABEL,
  categoryOf,
  colorOf,
  esc,
  fmtMetricValue,
  fmtMs,
  fmtTok,
  MARKER_COLORS,
  OURS,
  qs,
} from './common.js';

const dataset = qs('dataset');
const runId = qs('run');
if (!dataset || !runId) location.href = 'index.html';

const run = await (
  await fetch(
    `data/${encodeURIComponent(dataset)}/runs/${encodeURIComponent(runId)}.json`
  )
).json();
const wallMs = run.totalMs;
const metrics = run.metrics ?? [];

// Vertical timeline markers. Supplied metric offsets (TTFT, first chunk, …) plus two
// derived "first step" markers, because they can differ by seconds on a stalled run:
//   • first step body  = start of the earliest `step.execute` span (when the SDK began
//                         running the first step body)
//   • first step started = when the first step is *durably* started — the completion of
//                         the earliest `step_started` write. This matches the workflow
//                         event log's "Step Started", and can lag the body start a lot
//                         when that first write blocks (e.g. behind run_started).
const MARKERS = metrics
  .filter((m) => m.markerOffsetMs != null)
  .map((m, i) => ({
    label: m.label ?? m.key,
    offsetMs: Number(m.markerOffsetMs),
    color: MARKER_COLORS[i % MARKER_COLORS.length],
  }))
  .filter((m) => Number.isFinite(m.offsetMs));

const firstBodyMs = Math.min(
  ...run.spans
    .filter((s) => (s.name ?? '').startsWith('step.execute'))
    .map((s) => s.startMs)
);
// earliest-starting durable step-start write; its end ≈ the durable "Step Started".
const firstStartedWrite = run.spans
  .filter((s) => (s.name ?? '').includes('step_started'))
  .sort((a, b) => a.startMs - b.startMs)[0];
const firstStartedMs = firstStartedWrite
  ? firstStartedWrite.startMs + firstStartedWrite.durMs
  : Number.POSITIVE_INFINITY;

if (Number.isFinite(firstBodyMs)) {
  MARKERS.push({
    label: 'first step body',
    offsetMs: firstBodyMs,
    color: '#f5a623',
  });
}
if (Number.isFinite(firstStartedMs)) {
  MARKERS.push({
    label: 'first step started',
    offsetMs: firstStartedMs,
    color: '#ef4444',
  });
}

document.querySelector('.topbar a').href =
  `index.html?dataset=${encodeURIComponent(dataset)}`;
document.getElementById('runId').textContent = run.label ?? runId;
document.getElementById('origin').textContent =
  `${run.source} · origin ${run.originIso} · ${run.spanCount} spans · wall ${fmtMs(wallMs)}`;
document.title = `${run.label ?? runId} — waterfall`;

// ---------- header metric chips (data-driven) ----------
const chip = (k, v, cls) =>
  v == null || v === '' || v === '?'
    ? ''
    : `<div class="chip${cls ? ` ${cls}` : ''}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
document.getElementById('chips').innerHTML = [
  ...metrics.map((m) =>
    chip(
      m.label ?? m.key,
      fmtMetricValue(m),
      m.markerOffsetMs != null ? 'hi' : ''
    )
  ),
  chip('wall (spans)', fmtMs(wallMs)),
  chip('workflow HTTP', run.workflowHttpCount),
  chip('3rd-party HTTP', run.thirdPartyHttpCount),
  chip('AI spans', run.aiSpanCount),
].join('');

// ---------- per-trace tree structure (built once) ----------
const byId = new Map(run.spans.map((s) => [s.id, s]));
const byStart = (a, b) => a.startMs - b.startMs;
const traceStruct = run.traces.map((tr) => {
  const spans = run.spans.filter((s) => s.trace === tr.traceId);
  const kids = new Map();
  const roots = [];
  for (const s of spans) {
    if (
      s.parent &&
      byId.has(s.parent) &&
      byId.get(s.parent).trace === s.trace
    ) {
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    } else {
      roots.push(s);
    }
  }
  roots.sort(byStart);
  for (const arr of kids.values()) arr.sort(byStart);
  return { tr, kids, roots };
});

// ---------- state ----------
let zoom = 1;
let filterText = '';
let groupOther = true;
let onlyOurs = false;
const expandedGroups = new Set();

const groupable = (s) => s.httpOrigin === 'third-party';

// ---------- build display model (tree -> flat rows, with grouping) ----------
function buildModel() {
  const rows = [];
  let gid = 0;
  const grouping = groupOther && !filterText && !onlyOurs;

  for (const { tr, kids, roots } of traceStruct) {
    rows.push({ traceHead: tr });
    for (const r of roots) walk(r, 0, kids);
  }
  return rows;

  function walk(s, depth, kids) {
    rows.push({ span: s, depth });
    const cs = kids.get(s.id);
    if (!cs) return;
    let i = 0;
    while (i < cs.length) {
      if (grouping && groupable(cs[i])) {
        let j = i;
        while (j < cs.length && groupable(cs[j])) j++;
        const members = cs.slice(i, j);
        if (members.length >= 2) {
          const id = `g${gid++}`;
          const expanded = expandedGroups.has(id);
          rows.push(makeGroup(id, depth + 1, members, expanded));
          if (expanded) for (const mm of members) walkFlat(mm, depth + 2, kids);
          i = j;
          continue;
        }
      }
      walk(cs[i], depth + 1, kids);
      i++;
    }
  }
  // inside an expanded group we render members + their subtrees with no further grouping
  function walkFlat(s, depth, kids) {
    rows.push({ span: s, depth, inGroup: true });
    const cs = kids.get(s.id);
    if (cs) for (const c of cs) walkFlat(c, depth + 1, kids);
  }
}

function makeGroup(id, depth, members, expanded) {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  const vend = new Map();
  for (const s of members) {
    minStart = Math.min(minStart, s.startMs);
    maxEnd = Math.max(maxEnd, s.startMs + s.durMs);
    vend.set(s.vendor, (vend.get(s.vendor) || 0) + 1);
  }
  const vendors = [...vend.entries()].sort((a, b) => b[1] - a[1]);
  return {
    group: true,
    id,
    depth,
    members,
    expanded,
    startMs: minStart,
    durMs: maxEnd - minStart,
    vendors,
  };
}

// ---------- rendering ----------
const rowsEl = document.getElementById('rows');
const waterfall = document.getElementById('waterfall');
let RENDERED = [];

function setTrackWidth() {
  const labelW = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--label-w')
  );
  const base = Math.max(waterfall.clientWidth - labelW - 24, 600);
  document.documentElement.style.setProperty('--track-w', `${base * zoom}px`);
}

function rulerHtml() {
  const ticks = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    ticks.push(
      `<div class="tick" style="left:${(i / n) * 100}%"><span>${fmtMs((wallMs * i) / n)}</span></div>`
    );
  }
  return `<div class="ruler"><div class="label-pad"></div><div class="track">${ticks.join('')}</div></div>`;
}

function metaFor(s) {
  if (s.scope === 'ai') {
    const bits = [];
    if (s.model) bits.push(esc(s.model));
    if (s.inTok != null)
      bits.push(`<span class="tok">in ${fmtTok(s.inTok)}</span>`);
    if (s.outTok != null)
      bits.push(`<span class="tok">out ${fmtTok(s.outTok)}</span>`);
    return bits.join(' · ');
  }
  if (s.httpOrigin) return esc(s.vendor || s.host || '');
  if (s.httpRoute || s.httpStatus)
    return esc(
      [s.httpMethod, s.httpRoute, s.httpStatus].filter(Boolean).join(' ')
    );
  return esc(s.scope || s.service || '');
}

function barHtml(startMs, durMs, events) {
  const left = (startMs / wallMs) * 100;
  const width = Math.max((durMs / wallMs) * 100, 0.05);
  const evs = (events || [])
    .map((e) =>
      e.tMs == null
        ? ''
        : `<div class="ev" style="left:${(e.tMs / wallMs) * 100}%" title="${esc(e.name)} @ ${fmtMs(e.tMs)}"></div>`
    )
    .join('');
  return `${evs}<div class="barwrap" style="left:${left}%;width:${width}%"><div class="bar"></div><span class="durlabel">${fmtMs(durMs)}</span></div>`;
}

function rowHtml(r, i) {
  if (r.traceHead) {
    const t = r.traceHead;
    return `<div class="trace-head"><span>trace</span><span class="mono">${esc(t.traceId)}</span>· ${t.count} spans · root ${esc(t.service || '')}</div>`;
  }
  if (r.group) {
    const indent = 6 + r.depth * 13;
    const vstr = r.vendors.map(([v, c]) => `${esc(v)} ×${c}`).join(' · ');
    return `
      <div class="row group-row cat-other-http" style="--bar:var(--c-other-http)" data-i="${i}">
        <div class="label">
          <span class="cat"></span>
          <span class="tw">${r.expanded ? '▾' : '▸'}</span>
          <span class="name" style="padding-left:${indent}px">${r.members.length} 3rd-party spans</span>
          <span class="vendors">${vstr}</span>
        </div>
        <div class="track">${barHtml(r.startMs, r.durMs, null)}</div>
      </div>`;
  }
  const s = r.span;
  const cat = categoryOf(s);
  const indent = 6 + r.depth * 13;
  return `
    <div class="row cat-${cat}" style="--bar:${colorOf(s)}" data-i="${i}">
      <div class="label">
        <span class="cat"></span>
        <span class="name" style="padding-left:${indent}px" title="${esc(s.name)}">${esc(s.name)}</span>
        <span class="meta">${metaFor(s)}</span>
      </div>
      <div class="track">${barHtml(s.startMs, s.durMs, s.events)}</div>
    </div>`;
}

function visibleSpan(s) {
  if (onlyOurs && !OURS.has(categoryOf(s))) return false;
  if (filterText) {
    const hay =
      `${s.name} ${s.service} ${s.scope} ${s.model || ''} ${s.host || ''} ${s.vendor || ''} ${s.httpRoute || ''}`.toLowerCase();
    if (!hay.includes(filterText)) return false;
  }
  return true;
}

// Render MARKERS as full-height vertical lines at their ms offset from the trace
// origin, as overlays inside .rows so they scroll with the timeline.
function markersHtml() {
  return MARKERS.map((m) => {
    const frac = Math.max(0, Math.min(m.offsetMs / wallMs, 1));
    return `<div class="marker" style="left:calc(var(--label-w) + var(--track-w) * ${frac});border-color:${m.color}"><span class="mlabel" style="color:${m.color}">${esc(m.label)} ${fmtMs(m.offsetMs)}</span></div>`;
  }).join('');
}

function render() {
  setTrackWidth();
  const model = buildModel();

  // filter + drop trace heads that end up empty
  const kept = [];
  let head = null;
  const buf = [];
  const flush = () => {
    if (head && buf.length) kept.push(head, ...buf);
    head = null;
    buf.length = 0;
  };
  for (const r of model) {
    if (r.traceHead) {
      flush();
      head = r;
    } else if (r.group)
      buf.push(r); // groups only exist when not filtering/isolating
    else if (visibleSpan(r.span)) buf.push(r);
  }
  flush();

  RENDERED = kept;
  rowsEl.innerHTML = [
    rulerHtml(),
    ...kept.map((r, i) => rowHtml(r, i)),
    markersHtml(),
  ].join('');
}

// ---------- detail drawer ----------
const drawer = document.getElementById('drawer');
const dTitle = document.getElementById('dTitle');
const dBody = document.getElementById('dBody');
document.getElementById('dClose').onclick = closeDrawer;
function closeDrawer() {
  drawer.classList.remove('open');
  document.querySelectorAll('.row.sel').forEach((e) => {
    e.classList.remove('sel');
  });
}

function openDetail(s, rowEl) {
  document.querySelectorAll('.row.sel').forEach((e) => {
    e.classList.remove('sel');
  });
  rowEl?.classList.add('sel');
  dTitle.textContent = s.name;
  const cat = categoryOf(s);
  const kv = (k, v, mono) =>
    v == null || v === ''
      ? ''
      : `<div class="k">${esc(k)}</div><div class="v${mono ? ' mono' : ''}">${esc(v)}</div>`;
  const end = s.startMs + s.durMs;

  let html = `<div class="sec"><div class="kv">
    ${kv('category', cat === 'service' ? s.service : CAT_LABEL[cat])}
    ${kv('origin', s.httpOrigin === 'workflow' ? 'Vercel Workflow (ours)' : s.httpOrigin === 'third-party' ? 'third-party' : null)}
    ${kv('host', s.host)}
    ${kv('vendor', s.vendor)}
    ${kv('service', s.service)}
    ${kv('scope', s.scope)}
    ${kv('kind', s.kind)}
    ${kv('start', `${fmtMs(s.startMs)} (+${s.startMs.toFixed(1)}ms)`)}
    ${kv('duration', fmtMs(s.durMs))}
    ${kv('end', fmtMs(end))}
    ${kv('span id', s.id, true)}
    ${kv('parent', s.parent, true)}
    ${kv('trace', s.trace, true)}
  </div></div>`;

  if (s.scope === 'ai' || s.model) {
    html += `<div class="sec"><h3>Model call</h3><div class="kv">
      ${kv('model', s.model)}
      ${kv('input tokens', s.inTok)}
      ${kv('output tokens', s.outTok)}
      ${kv('finish', s.finish)}
    </div></div>`;
  }

  if (s.events?.length) {
    html += `<div class="sec"><h3>Events (${s.events.length})</h3><div class="events-list">${s.events
      .map(
        (e) =>
          `<div class="e"><span>${esc(e.name)}</span><span class="t">${e.tMs == null ? '' : `+${fmtMs(e.tMs)}`}</span></div>`
      )
      .join('')}</div></div>`;
  }

  const attrEntries = Object.entries(s.attrs || {}).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  if (attrEntries.length) {
    html += `<div class="sec"><h3>Attributes (${attrEntries.length})</h3><div class="attrs">${attrEntries
      .map(
        ([k, v]) =>
          `<div class="arow"><div class="ak">${esc(k)}</div><div class="av">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</div></div>`
      )
      .join('')}</div></div>`;
  }

  dBody.innerHTML = html;
  drawer.classList.add('open');
}

rowsEl.addEventListener('click', (e) => {
  const rowEl = e.target.closest('.row');
  if (!rowEl) return;
  const r = RENDERED[+rowEl.dataset.i];
  if (!r) return;
  if (r.group) {
    if (r.expanded) expandedGroups.delete(r.id);
    else expandedGroups.add(r.id);
    render();
  } else if (r.span) {
    openDetail(r.span, rowEl);
  }
});

// ---------- controls ----------
const filterEl = document.getElementById('filter');
filterEl.addEventListener('input', () => {
  filterText = filterEl.value.trim().toLowerCase();
  render();
});
document.getElementById('groupOther').addEventListener('change', (e) => {
  groupOther = e.target.checked;
  render();
});
document.getElementById('onlyOurs').addEventListener('change', (e) => {
  onlyOurs = e.target.checked;
  render();
});
document.getElementById('zoomIn').onclick = () => {
  zoom = Math.min(zoom * 1.6, 60);
  render();
};
document.getElementById('zoomOut').onclick = () => {
  zoom = Math.max(zoom / 1.6, 1);
  render();
};
document.getElementById('zoomReset').onclick = () => {
  zoom = 1;
  render();
};
window.addEventListener('resize', () => {
  if (zoom === 1) render();
});

// ---------- hover crosshair (viewport-fixed line + live time readout) ----------
const crosshair = document.getElementById('crosshair');
const ctime = crosshair.querySelector('.ctime');
const cssPx = (name) =>
  parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name)
  ) || 0;
waterfall.addEventListener('mousemove', (e) => {
  const r = waterfall.getBoundingClientRect();
  const labelW = cssPx('--label-w');
  const trackW = cssPx('--track-w');
  const xView = e.clientX - r.left;
  const frac = (xView + waterfall.scrollLeft - labelW) / trackW;
  if (xView < labelW || frac < 0 || frac > 1) {
    crosshair.style.display = 'none';
    return;
  }
  crosshair.style.display = 'block';
  crosshair.style.left = `${e.clientX}px`;
  crosshair.style.top = `${r.top}px`;
  crosshair.style.height = `${r.height}px`;
  ctime.textContent = fmtMs(frac * wallMs);
});
waterfall.addEventListener('mouseleave', () => {
  crosshair.style.display = 'none';
});

// ---------- legend (markers + categories present) ----------
const markerLegend = MARKERS.map(
  (m) =>
    `<span><i style="border-left:2px dashed ${m.color};width:0;background:none"></i>${esc(m.label)}</span>`
).join('');
const legendEntries = new Map();
for (const s of run.spans) {
  const c = categoryOf(s);
  const key = c === 'service' ? `svc:${s.service}` : c;
  if (!legendEntries.has(key))
    legendEntries.set(key, {
      color: colorOf(s),
      label: c === 'service' ? (s.service ?? 'service') : CAT_LABEL[c],
    });
}
const KNOWN_ORDER = [
  'workflow-http',
  'workflow',
  'ai',
  'other-http',
  'serverless',
  'edge',
  'next',
  'fetch',
];
const entries = [...legendEntries.entries()].sort(([a], [b]) => {
  const ia = KNOWN_ORDER.indexOf(a);
  const ib = KNOWN_ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.localeCompare(b);
});
document.getElementById('legend').innerHTML =
  markerLegend +
  entries
    .map(
      ([, e]) =>
        `<span><i style="background:${e.color}"></i>${esc(e.label)}</span>`
    )
    .join('');

render();
