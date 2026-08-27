// Datadog-style flame graph: x = wall time, y = tree depth. Built for one job —
// explaining STSO, the stretch between one `step.execute` ending and the next
// beginning. Pick a gap on the left, the graph zooms to it and the panel underneath
// says where the time went.

import {
  applyReparent,
  buildForest,
  datadogSpanUrl,
  spanEnd,
  stsoGaps,
  userStepExecutes,
  windowBreakdown,
  wsReparentPlan,
} from './analysis.js';
import {
  CAT_LABEL,
  categoryOf,
  colorOf,
  esc,
  fmtMs,
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
const ROW_H = 17;

document.getElementById('runId').textContent = run.label ?? runId;
document.getElementById('origin').textContent =
  `${run.source} · origin ${run.originIso} · ${run.spanCount} spans · wall ${fmtMs(wallMs)}`;
document.title = `${run.label ?? runId} — flame`;
document.getElementById('toWaterfall').href =
  `run.html?dataset=${encodeURIComponent(dataset)}&run=${encodeURIComponent(runId)}`;

// ---------- reparenting (recomputed only when toggled) ----------
const plan = wsReparentPlan(run.spans);
document.getElementById('rpStat').textContent = plan.matched
  ? `(${plan.matched}${plan.unmatched ? ` of ${plan.matched + plan.unmatched}` : ''})`
  : '(none found)';
if (!plan.matched) document.getElementById('reparent').disabled = true;

let reparent = plan.matched > 0;
let onlyOurs = false;
let filterText = '';
let sortMode = 'time';

let spans;
let forest;
let gaps;
let maxDepth;
let replaySkipped = 0;
let userStepName = new Map(); // inner span id -> step name (inner spans are unnamed)
let selectedGap = null;
let selectedSpan = null;

function rebuild() {
  spans = reparent ? applyReparent(run.spans, plan.map) : run.spans;
  forest = buildForest(spans);
  ({ gaps, replaySkipped } = stsoGaps(spans));
  userStepName = new Map(
    userStepExecutes(spans).map((u) => [u.span.id, u.name])
  );
  maxDepth = Math.max(0, ...forest.depth.values());
  // A reparent moves spans between subtrees, so any index into the old tree is stale.
  selectedSpan = null;
}

// ---------- view window + zoom history ----------
let view = { from: 0, to: wallMs };
const history = [];

const MIN_SPAN_MS = 0.05; // ~50us; below this the ruler stops meaning anything

// Clamp a window into [0, wallMs] while preserving its width, so zooming or panning
// against an edge slides the window instead of silently shrinking it.
function clampView(from, span) {
  const w = Math.min(Math.max(span, MIN_SPAN_MS), wallMs);
  const f = Math.max(0, Math.min(from, wallMs - w));
  return { from: f, to: f + w };
}

function setView(from, to, label) {
  history.push({ ...view, label });
  view = clampView(from, to - from);
  render();
}

// Zoom about a fixed point: the wall time under the cursor must not move, which is what
// makes wheel zoom feel like it tracks the pointer instead of the window centre.
// Deliberately does not touch `history` - a breadcrumb per wheel notch would bury the
// gap and span entries that are actually worth stepping back to.
function zoomAt(frac, factor) {
  const span = view.to - view.from;
  const anchor = view.from + span * frac;
  const next = Math.min(Math.max(span * factor, MIN_SPAN_MS), wallMs);
  view = clampView(anchor - (anchor - view.from) * (next / span), next);
}

function panBy(dtMs) {
  view = clampView(view.from + dtMs, view.to - view.from);
}
function popView() {
  if (!history.length) return;
  view = history.pop();
  render();
}
function resetView() {
  history.length = 0;
  view = { from: 0, to: wallMs };
  selectedGap = null;
  render();
}

// ---------- STSO sidebar ----------
const stsoListEl = document.getElementById('stsoList');
const stsoSumEl = document.getElementById('stsoSum');
// Overlapping steps are merged into one cluster, so a gap can sit against a batch of
// parallel steps rather than a single one; say so instead of naming one arbitrarily.
const par = (n) =>
  n > 1
    ? `<span class="par" title="${n} steps ran in parallel">+${n - 1}</span>`
    : '';

function renderStso() {
  if (!gaps.length) {
    stsoSumEl.textContent = 'no consecutive steps in this run';
    stsoListEl.innerHTML = '';
    return;
  }
  const sorted = [...gaps].sort((a, b) =>
    sortMode === 'size' ? b.gapMs - a.gapMs : a.fromMs - b.fromMs
  );
  const vals = gaps.map((g) => g.gapMs).sort((a, b) => a - b);
  const p50 = vals[Math.floor(vals.length / 2)];
  const p90 = vals[Math.floor(vals.length * 0.9)];
  const total = vals.reduce((a, b) => a + b, 0);
  stsoSumEl.innerHTML =
    `<span>${gaps.length} gaps</span><span>p50 ${fmtMs(p50)}</span>` +
    `<span>p90 ${fmtMs(p90)}</span><span>total ${fmtMs(total)}</span>` +
    (replaySkipped
      ? `<span class="warn" title="Outer step spans that ran no user code (replays). Excluded: they are not a step boundary.">${replaySkipped} replay${replaySkipped > 1 ? 's' : ''} skipped</span>`
      : '');

  const worst = Math.max(...vals);
  stsoListEl.innerHTML = sorted
    .map((g) => {
      const pct = worst > 0 ? (g.gapMs / worst) * 100 : 0;
      const on = selectedGap?.index === g.index ? ' on' : '';
      return `<button class="gap${on}" data-gap="${g.index}">
        <div class="gtop"><span class="gn">#${g.index + 1}</span><span class="gd">${fmtMs(g.gapMs)}</span></div>
        <div class="gnames">${esc(g.prevName)}${par(g.prevParallel)} <span class="arr">→</span> ${esc(g.nextName)}${par(g.nextParallel)}</div>
        <div class="gbar"><i style="width:${pct}%"></i></div>
      </button>`;
    })
    .join('');
}

stsoListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.gap');
  if (!btn) return;
  const g = gaps[+btn.dataset.gap];
  if (!g) return;
  selectedGap = g;
  // Pad by 12% of the gap so the bracketing step.execute edges stay on screen — the
  // gap means little without the two steps it sits between.
  const pad = Math.max(g.gapMs * 0.12, 2);
  setView(g.fromMs - pad, g.toMs + pad, `STSO #${g.index + 1}`);
});

for (const b of document.querySelectorAll('.stso-sort button')) {
  b.addEventListener('click', () => {
    sortMode = b.dataset.sort;
    for (const o of document.querySelectorAll('.stso-sort button'))
      o.classList.toggle('on', o === b);
    renderStso();
  });
}

// ---------- flame rendering ----------
const framesEl = document.getElementById('frames');
const flameEl = document.getElementById('flame');
const rulerEl = document.getElementById('ruler');
const crumbsEl = document.getElementById('crumbs');
const viewRangeEl = document.getElementById('viewRange');
const breakdownEl = document.getElementById('breakdown');
let RENDERED = [];

const dim = (s) => {
  if (onlyOurs && !OURS.has(categoryOf(s))) return true;
  if (!filterText) return false;
  const hay =
    `${s.name} ${s.service} ${s.scope} ${s.host || ''} ${s.vendor || ''}`.toLowerCase();
  return !hay.includes(filterText);
};

function renderFlame() {
  const { from, to } = view;
  const span = to - from;
  const px = flameEl.clientWidth || 1200;
  const minPx = 0.35; // anything thinner cannot be seen or clicked
  const out = [];
  RENDERED = [];

  for (const s of spans) {
    const e = spanEnd(s);
    if (e < from || s.startMs > to) continue;
    const w = ((Math.min(e, to) - Math.max(s.startMs, from)) / span) * px;
    // Outline the user-code step spans, not every `step.execute`: the outer wrapper and
    // replay spans are not the boundaries STSO is measured between.
    const isStep = userStepName.has(s.id);
    if (w < minPx && !isStep) continue;
    const d = forest.depth.get(s.id) ?? 0;
    const left = ((Math.max(s.startMs, from) - from) / span) * 100;
    const width = Math.max((w / px) * 100, 0.06);
    const i = RENDERED.length;
    RENDERED.push(s);
    const cls = [
      'fr',
      dim(s) ? 'dim' : '',
      isStep ? 'step' : '',
      s.wsReparented ? 'rp' : '',
      selectedSpan === s.id ? 'sel' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const label = isStep
      ? `${userStepName.get(s.id)} (user code)`
      : (s.name ?? '');
    out.push(
      `<div class="${cls}" data-i="${i}" style="left:${left}%;width:${width}%;top:${d * ROW_H}px;background:${colorOf(s)}"><span>${esc(label)}</span></div>`
    );
  }

  // The gap itself, drawn behind the frames, so "what is inside this window" is literal.
  let overlay = '';
  if (selectedGap) {
    const l = ((selectedGap.fromMs - from) / span) * 100;
    const w = ((selectedGap.toMs - selectedGap.fromMs) / span) * 100;
    if (l < 100 && l + w > 0)
      overlay = `<div class="gapband" style="left:${l}%;width:${w}%"><span>STSO #${selectedGap.index + 1} · ${fmtMs(selectedGap.gapMs)}</span></div>`;
  }

  framesEl.style.height = `${(maxDepth + 1) * ROW_H + 8}px`;
  framesEl.innerHTML = overlay + out.join('');
  viewRangeEl.textContent = `${fmtMs(from)} → ${fmtMs(to)}  (${fmtMs(span)})`;
}

function renderRuler() {
  const { from, to } = view;
  const n = 10;
  const ticks = [];
  for (let i = 0; i <= n; i++)
    ticks.push(
      `<div class="tick" style="left:${(i / n) * 100}%"><span>${fmtMs(from + ((to - from) * i) / n)}</span></div>`
    );
  const sel = document.getElementById('rulerSel');
  rulerEl.innerHTML = ticks.join('');
  rulerEl.appendChild(sel);
}

function renderCrumbs() {
  const parts = [`<button data-pop="0">whole run</button>`];
  history.forEach((h, i) => {
    if (h.label)
      parts.push(`<button data-pop="${i + 1}">${esc(h.label)}</button>`);
  });
  crumbsEl.innerHTML = parts.join('<span class="sep">›</span>');
}

function renderBreakdown() {
  const { from, to } = view;
  const rows = windowBreakdown(spans, from, to, forest.kids).slice(0, 14);
  if (!rows.length) {
    breakdownEl.innerHTML = '';
    return;
  }
  const head = selectedGap
    ? `Inside STSO #${selectedGap.index + 1} — ${esc(selectedGap.prevName)} → ${esc(selectedGap.nextName)} (${fmtMs(selectedGap.gapMs)})`
    : `Inside ${fmtMs(from)} → ${fmtMs(to)}`;
  const max = Math.max(...rows.map((r) => r.selfMs), 0.001);
  breakdownEl.innerHTML = `
    <div class="bhead">${head}<span class="hint">self time = not covered by a child; that is the row actually costing you</span></div>
    <table class="btable"><thead><tr><th>self</th><th>total</th><th>n</th><th>span</th><th>service</th><th></th></tr></thead><tbody>
    ${rows
      .map(
        (r) => `<tr>
          <td class="num strong">${fmtMs(r.selfMs)}</td>
          <td class="num">${fmtMs(r.totalMs)}</td>
          <td class="num">${r.count}</td>
          <td class="nm" title="${esc(r.name)}">${esc(r.name)}</td>
          <td class="sv">${esc(r.service ?? '')}</td>
          <td class="bx"><i style="width:${(r.selfMs / max) * 100}%;background:${colorOf(r.span)}"></i></td>
        </tr>`
      )
      .join('')}
    </tbody></table>`;
}

function render() {
  renderRuler();
  renderCrumbs();
  renderFlame();
  renderBreakdown();
  renderStso();
}

// Wheel events arrive far faster than a repaint is worth, so coalesce to one per frame.
// The breakdown is a full pass over every span, so it trails the gesture rather than
// running inside it; and it is skipped entirely while a span's attributes are on show,
// which would otherwise be clobbered mid-scroll.
let viewportRaf = 0;
let breakdownTimer = 0;
function renderViewport() {
  if (!viewportRaf) {
    viewportRaf = requestAnimationFrame(() => {
      viewportRaf = 0;
      renderRuler();
      renderFlame();
    });
  }
  clearTimeout(breakdownTimer);
  breakdownTimer = setTimeout(() => {
    if (!selectedSpan) renderBreakdown();
  }, 90);
}

// ---------- interaction ----------
const tip = document.getElementById('tip');
framesEl.addEventListener('mousemove', (e) => {
  const el = e.target.closest('.fr');
  if (!el) {
    tip.style.display = 'none';
    return;
  }
  const s = RENDERED[+el.dataset.i];
  if (!s) return;
  const cat = categoryOf(s);
  const userName = userStepName.get(s.id);
  tip.innerHTML =
    `<b>${esc(userName ? `${userName} (user code step)` : (s.name ?? ''))}</b>` +
    `<div class="tl"><span>duration</span><span>${fmtMs(s.durMs)}</span></div>` +
    `<div class="tl"><span>start</span><span>+${fmtMs(s.startMs)}</span></div>` +
    `<div class="tl"><span>service</span><span>${esc(s.service ?? '')}</span></div>` +
    `<div class="tl"><span>kind</span><span>${esc(cat === 'service' ? s.service : CAT_LABEL[cat])}</span></div>` +
    (s.httpStatus
      ? `<div class="tl"><span>status</span><span>${esc(s.httpStatus)}</span></div>`
      : '') +
    (s.wsReparented
      ? `<div class="tl rpnote"><span>reparented</span><span>to its WS frame</span></div>`
      : '') +
    `<div class="tl hint2"><span>click</span><span>details${datadogSpanUrl(run, s) ? ' + Datadog link' : ''} · dbl-click zooms</span></div>`;
  tip.style.display = 'block';
  const pad = 14;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(e.clientX + pad, window.innerWidth - w - 8)}px`;
  tip.style.top = `${Math.min(e.clientY + pad, window.innerHeight - tip.offsetHeight - 8)}px`;
});
framesEl.addEventListener('mouseleave', () => {
  tip.style.display = 'none';
});

framesEl.addEventListener('click', (e) => {
  const el = e.target.closest('.fr');
  if (!el) return;
  const s = RENDERED[+el.dataset.i];
  if (!s) return;
  selectedSpan = s.id;
  showSpanDetail(s);
  renderFlame();
});
framesEl.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.fr');
  if (!el) return;
  const s = RENDERED[+el.dataset.i];
  if (!s) return;
  const pad = Math.max(s.durMs * 0.05, 0.5);
  selectedGap = null;
  setView(s.startMs - pad, spanEnd(s) + pad, (s.name ?? 'span').slice(0, 28));
});

// A link back to the same span in Datadog. `rel=noreferrer` because the URL carries the
// trace and span ids and there is no reason to leak this page's address alongside them.
function ddLink(s) {
  const url = datadogSpanUrl(run, s);
  return url
    ? `<a class="ddlink" href="${esc(url)}" target="_blank" rel="noreferrer noopener">Datadog ↗</a>`
    : '';
}

function showSpanDetail(s) {
  const attrs = Object.entries(s.attrs ?? {})
    .flatMap(function walk([k, v]) {
      return v && typeof v === 'object' && !Array.isArray(v)
        ? Object.entries(v).flatMap(([k2, v2]) => walk([`${k}.${k2}`, v2]))
        : [[k, v]];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
  breakdownEl.innerHTML = `
    <div class="bhead">${esc(s.name ?? '')} <span class="hint">${fmtMs(s.durMs)} · +${fmtMs(s.startMs)} · ${esc(s.service ?? '')}${s.wsReparented ? ' · reparented to its WS frame' : ''}</span>
      ${ddLink(s)}
      <button class="backb" id="backToBreakdown">◂ window breakdown</button></div>
    <div class="attrs">${attrs
      .map(
        ([k, v]) =>
          `<div class="arow"><div class="ak">${esc(k)}</div><div class="av">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</div></div>`
      )
      .join('')}</div>`;
  document.getElementById('backToBreakdown').onclick = () => {
    selectedSpan = null;
    renderBreakdown();
    renderFlame();
  };
}

// Wheel zooms at the pointer. The flame graph is the point of this page, so it claims
// the gesture rather than scrolling the document; Shift (or a horizontal wheel/trackpad
// swipe) pans, and Alt falls through to native scrolling for traces deep enough to
// overflow vertically.
flameEl.addEventListener(
  'wheel',
  (e) => {
    if (e.altKey) return; // let the browser scroll the frame stack
    e.preventDefault();
    const r = framesEl.getBoundingClientRect();
    const w = Math.max(r.width, 1);
    // deltaMode is lines (1) or pages (2) on some browsers; normalise to pixels or a
    // single notch would zoom by orders of magnitude there.
    const unit =
      e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height || 400 : 1;
    const dy = e.deltaY * unit;
    const dx = e.deltaX * unit;

    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      panBy((view.to - view.from) * ((e.shiftKey ? dy : dx) / w));
    } else {
      const frac = Math.min(Math.max((e.clientX - r.left) / w, 0), 1);
      // exp() makes every notch a constant ratio, so zooming in and back out lands
      // where you started; the clamp keeps one violent trackpad flick from jumping
      // the whole run in a single event.
      zoomAt(frac, Math.exp(Math.min(Math.max(dy, -240), 240) * 0.0022));
    }
    renderViewport();
  },
  { passive: false }
);

// Drag across the ruler to zoom to an arbitrary range.
let dragFrom = null;
const selEl = document.getElementById('rulerSel');
const xToMs = (clientX) => {
  const r = rulerEl.getBoundingClientRect();
  const frac = Math.max(0, Math.min((clientX - r.left) / r.width, 1));
  return view.from + frac * (view.to - view.from);
};
rulerEl.addEventListener('mousedown', (e) => {
  dragFrom = { x: e.clientX, ms: xToMs(e.clientX) };
  selEl.style.display = 'block';
});
window.addEventListener('mousemove', (e) => {
  if (!dragFrom) return;
  const r = rulerEl.getBoundingClientRect();
  const a = Math.min(dragFrom.x, e.clientX) - r.left;
  const b = Math.max(dragFrom.x, e.clientX) - r.left;
  selEl.style.left = `${Math.max(0, a)}px`;
  selEl.style.width = `${Math.min(b, r.width) - Math.max(0, a)}px`;
});
window.addEventListener('mouseup', (e) => {
  if (!dragFrom) return;
  const from = dragFrom.ms;
  const to = xToMs(e.clientX);
  dragFrom = null;
  selEl.style.display = 'none';
  selEl.style.width = '0px';
  if (Math.abs(to - from) < 0.2) return; // a click, not a drag
  selectedGap = null;
  setView(Math.min(from, to), Math.max(from, to), 'range');
});

crumbsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-pop]');
  if (!b) return;
  const n = +b.dataset.pop;
  if (n === 0) return resetView();
  history.length = n;
  view = history.pop();
  render();
});

document.getElementById('zoomOutBtn').onclick = popView;
document.getElementById('resetBtn').onclick = resetView;
document.getElementById('reparent').addEventListener('change', (e) => {
  reparent = e.target.checked;
  rebuild();
  render();
});
document.getElementById('onlyOurs').addEventListener('change', (e) => {
  onlyOurs = e.target.checked;
  renderFlame();
});
const filterEl = document.getElementById('filter');
filterEl.addEventListener('input', () => {
  filterText = filterEl.value.trim().toLowerCase();
  renderFlame();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') popView();
  if (e.target === filterEl) return;
  if (e.key === '[' || e.key === ']') {
    const list = [...gaps].sort((a, b) =>
      sortMode === 'size' ? b.gapMs - a.gapMs : a.fromMs - b.fromMs
    );
    const at = selectedGap
      ? list.findIndex((g) => g.index === selectedGap.index)
      : -1;
    const nx =
      list[
        Math.max(0, Math.min(at + (e.key === ']' ? 1 : -1), list.length - 1))
      ];
    if (!nx) return;
    selectedGap = nx;
    const pad = Math.max(nx.gapMs * 0.12, 2);
    setView(nx.fromMs - pad, nx.toMs + pad, `STSO #${nx.index + 1}`);
  }
});
window.addEventListener('resize', () => renderFlame());

// ---------- legend ----------
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
document.getElementById('legend').innerHTML = [...legendEntries.values()]
  .map(
    (e) => `<span><i style="background:${e.color}"></i>${esc(e.label)}</span>`
  )
  .join('');

rebuild();
render();

// Deep link: ?gap=N opens straight into one STSO instance.
const wanted = Number(qs('gap'));
if (Number.isFinite(wanted) && gaps[wanted - 1]) {
  const g = gaps[wanted - 1];
  selectedGap = g;
  const pad = Math.max(g.gapMs * 0.12, 2);
  setView(g.fromMs - pad, g.toMs + pad, `STSO #${g.index + 1}`);
}
