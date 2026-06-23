import { esc, fmtMetricValue, fmtMs, qs } from './common.js';

const titleEl = document.getElementById('title');
const subEl = document.getElementById('sub');
const contentEl = document.getElementById('content');

const datasets =
  (await (await fetch('data/datasets.json')).json()).datasets ?? [];
if (datasets.length === 0) {
  subEl.textContent =
    'No datasets yet. Run an importer (see README): import:axiom or import:datadog.';
} else {
  let dsId = qs('dataset');
  if (!dsId && datasets.length === 1) dsId = datasets[0].id;
  if (!dsId) renderDatasetPicker();
  else await renderTraceTable(dsId);
}

function renderDatasetPicker() {
  titleEl.textContent = 'APM trace viewer';
  subEl.textContent = `${datasets.length} datasets. Pick one to view its traces.`;
  contentEl.innerHTML = `<table class="runs"><thead><tr><th>Dataset</th><th>Source</th><th class="num">Traces</th><th>Imported</th></tr></thead><tbody>${datasets
    .map(
      (d) =>
        `<tr><td class="run"><a href="index.html?dataset=${encodeURIComponent(d.id)}">${esc(d.title)}</a></td><td>${esc(d.source)}</td><td class="num">${d.traceCount}</td><td>${esc((d.importedAt ?? '').replace('T', ' ').slice(0, 19))}</td></tr>`
    )
    .join('')}</tbody></table>`;
}

async function renderTraceTable(dsId) {
  const ds = await (
    await fetch(`data/${encodeURIComponent(dsId)}/index.json`)
  ).json();
  const traces = ds.traces ?? [];
  titleEl.textContent = ds.title ?? dsId;

  // metric columns = union of metric keys across traces, in first-seen order
  const metricCols = [];
  const seen = new Set();
  for (const t of traces) {
    for (const m of t.metrics ?? []) {
      if (!seen.has(m.key)) {
        seen.add(m.key);
        metricCols.push({ key: m.key, label: m.label ?? m.key });
      }
    }
  }
  // marker keys (for the mini timeline) = metric keys that carry an offset
  const markerKeys = [];
  for (const t of traces) {
    for (const m of t.metrics ?? []) {
      if (m.markerOffsetMs != null && !markerKeys.includes(m.key))
        markerKeys.push(m.key);
    }
  }
  const maxWall = Math.max(1, ...traces.map((t) => t.wallMs || 0));

  const switcher =
    datasets.length > 1 ? ' · <a href="index.html">← all datasets</a>' : '';
  subEl.innerHTML = `${esc(ds.source)} · ${traces.length} traces${switcher}. Click a trace to open its waterfall.`;

  const cols = [
    { key: 'label', label: 'Trace', num: false },
    ...metricCols.map((c) => ({ ...c, num: true, metric: true })),
    { key: 'wallMs', label: 'Wall', num: true },
    { key: 'spanCount', label: 'Spans', num: true },
    { key: 'workflowHttpCount', label: 'WF HTTP', num: true },
    { key: 'thirdPartyHttpCount', label: '3P HTTP', num: true },
    { key: 'aiSpanCount', label: 'AI', num: true },
  ];

  let sortKey = markerKeys[0] ?? 'wallMs';
  let sortDir = -1;

  const metricOf = (t, key) => (t.metrics ?? []).find((m) => m.key === key);
  const cellValue = (t, c) => {
    if (c.metric) {
      const m = metricOf(t, c.key);
      return m ? fmtMetricValue(m) : '—';
    }
    if (c.key === 'label') return t.label;
    if (c.key === 'wallMs') return fmtMs(t.wallMs);
    return t[c.key] ?? 0;
  };
  const sortVal = (t, key) => {
    const m = metricOf(t, key);
    if (m)
      return typeof m.value === 'number'
        ? m.value
        : Number.parseFloat(m.value) || 0;
    return typeof t[key] === 'number' ? t[key] : (t[key] ?? '');
  };

  function miniTimeline(t) {
    const palette = ['var(--c-ai)', '#10b981', '#f5a623'];
    const total = ((t.wallMs || 0) / maxWall) * 100;
    let spans = `<span style="left:0;width:${total}%;background:var(--c-other-http);opacity:.25"></span>`;
    markerKeys
      .map((k) => metricOf(t, k))
      .filter((m) => m && m.markerOffsetMs != null)
      .map((m) => Number(m.markerOffsetMs))
      .sort((a, b) => a - b)
      .forEach((o, i) => {
        const left = Math.min(o / maxWall, 1) * 100;
        spans += `<span style="left:${left}%;width:2px;background:${palette[i % palette.length]}"></span>`;
      });
    return `<div class="mini">${spans}</div>`;
  }

  function render() {
    traces.sort((a, b) => {
      const av = sortVal(a, sortKey);
      const bv = sortVal(b, sortKey);
      if (typeof av === 'string' || typeof bv === 'string')
        return sortDir * String(av).localeCompare(String(bv));
      return sortDir * (av - bv);
    });
    const head = `<tr>${cols.map((c) => `<th data-sort="${c.key}"${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}<th>Timeline</th></tr>`;
    const body = traces
      .map((t) => {
        const tds = cols
          .map((c) => {
            if (c.key === 'label')
              return `<td class="run"><a href="run.html?dataset=${encodeURIComponent(dsId)}&run=${encodeURIComponent(t.id)}">${esc(t.label)}</a></td>`;
            return `<td class="num">${esc(cellValue(t, c))}</td>`;
          })
          .join('');
        return `<tr>${tds}<td class="bar-cell">${miniTimeline(t)}</td></tr>`;
      })
      .join('');
    contentEl.innerHTML = `<table class="runs"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    for (const th of contentEl.querySelectorAll('th[data-sort]')) {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (sortKey === k) sortDir *= -1;
        else {
          sortKey = k;
          sortDir = k === 'label' ? 1 : -1;
        }
        render();
      });
    }
  }
  render();
}
