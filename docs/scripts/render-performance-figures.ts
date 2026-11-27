/**
 * Renders the release figures for /docs/performance from lib/performance/results.json:
 * one HTML page per figure and theme, captured at 2x with the agent-browser CLI into
 * public/performance/v<latest version>/.
 *
 *   bun ./scripts/render-performance-figures.ts            # render and capture
 *   bun ./scripts/render-performance-figures.ts --html-only # write the HTML, print its path
 *
 * The figures use the Geist and Geist Mono fonts installed on the machine. Every number
 * comes from the results data, the same as the page's generated prose and table.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  change,
  count,
  figuresPath,
  isSame,
  isSlower,
  lanes,
  min,
  ms,
  pick,
  ratio,
  recording,
  sec,
  showP99,
  type Trio,
  versions,
} from '../lib/performance';

const OUT = fileURLToPath(new URL(`../public${figuresPath}/`, import.meta.url));
const WIDTH = 1008;

const T = lanes('timing');
const D = lanes('deep');
const P = lanes('parallel');
const R = lanes('resume');
const S = lanes('stream');
const AL = lanes('agentLoop');
const { oldest: OLD, previous: PREV, latest: NEW } = versions;
const ORDER = ['oldest', 'previous', 'latest'] as const;
const NAMES = { oldest: OLD, previous: PREV, latest: NEW };

type Theme = {
  bg: string;
  ink: string;
  ink2: string;
  grid: string;
  series: Record<(typeof ORDER)[number], string>;
};
const THEMES: Record<'light' | 'dark', Theme> = {
  light: {
    bg: '#ffffff',
    ink: '#0a0a0a',
    ink2: '#5e5e5e',
    grid: '#e6e6e6',
    series: { oldest: '#ffffff', previous: '#8f8f8f', latest: '#0a0a0a' },
  },
  dark: {
    bg: '#000000',
    ink: '#ededed',
    ink2: '#a1a1a1',
    grid: '#2e2e2e',
    series: { oldest: '#000000', previous: '#7d7d7d', latest: '#ededed' },
  },
};
const BAR = {
  light: { oldest: '#c2c2c2', previous: '#8f8f8f', latest: '#0a0a0a' },
  dark: { oldest: '#4a4a4a', previous: '#8a8a8a', latest: '#ededed' },
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Inline `code` in captions becomes Geist Mono. */
const prose = (s: string) =>
  esc(s).replace(/`([^`]+)`/g, '<span class="mono">$1</span>');

// Layout: a label column, the plot, and a value column, in CSS px.
const PAD = 24;
const LABEL_W = 300;
const VALUE_W = 220;
const PLOT_X = PAD + LABEL_W + 16;
const PLOT_W = WIDTH - PAD * 2 - LABEL_W - VALUE_W - 32;
const VALUE_X = PLOT_X + PLOT_W + 22;

/** A round axis maximum and ticks for a linear scale from 0. */
function niceTicks(
  max: number,
  target = 5,
  unitMs = 1
): { top: number; ticks: number[] } {
  if (unitMs !== 1) {
    const inUnits = niceTicks(max / unitMs, target);
    return {
      top: inUnits.top * unitMs,
      ticks: inUnits.ticks.map((v) => v * unitMs),
    };
  }
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
}

const tickLabel = (v: number, unit: 'ms' | 's' | 'min') => {
  if (v === 0) return '0';
  if (unit === 'min') return `${v / 60_000} min`;
  if (unit === 's') return `${v / 1000} s`;
  return v >= 1000 ? `${(v / 1000).toLocaleString('en-US')} s` : `${v} ms`;
};

function axis(
  top: number,
  ticks: number[],
  unit: 'ms' | 's' | 'min',
  y0: number,
  y1: number,
  t: Theme
) {
  const x = (v: number) => PLOT_X + (v / top) * PLOT_W;
  return ticks
    .map(
      (v) =>
        `<line x1="${x(v)}" x2="${x(v)}" y1="${y0}" y2="${y1}" stroke="${t.grid}"/>` +
        `<text x="${x(v)}" y="${y0 - 14}" text-anchor="middle" class="tick">${tickLabel(v, unit)}</text>`
    )
    .join('');
}

const label = (y: number, title: string, sub: string) =>
  `<text x="${PAD}" y="${y - 2}" class="row">${esc(title)}</text>` +
  `<text x="${PAD}" y="${y + 18}" class="sub">${esc(sub)}</text>`;

const value = (y: number, head: string, sub: string) =>
  `<text x="${VALUE_X}" y="${y - 2}" class="row">${esc(head)}</text>` +
  `<text x="${VALUE_X}" y="${y + 18}" class="sub">${esc(sub)}</text>`;

const dot = (
  x: number,
  y: number,
  which: (typeof ORDER)[number],
  t: Theme,
  r = 7
) =>
  which === 'oldest'
    ? `<circle cx="${x}" cy="${y}" r="${r - 1}" fill="${t.bg}" stroke="${t.ink}" stroke-width="2.5"/>`
    : `<circle cx="${x}" cy="${y}" r="${r}" fill="${t.series[which]}"${which === 'previous' ? ` stroke="${t.bg}" stroke-width="1.5"` : ''}/>`;

/** Comparison text for the value column: the change from the previous version. */
const changeHead = (v: Trio<number>) => {
  const c = change(v.previous, v.latest);
  return c === 'No change' ? `No change from ${PREV}` : `${c} than ${PREV}`;
};
const path3 = (v: Trio<number>, fmt: (n: number) => string) =>
  ORDER.map((k) => fmt(v[k])).join(' → ');

type DumbbellRow = { title: string; sub: string; values: Trio<number> };

/** Rows of three markers on one linear axis; returns the SVG and its height. */
function dumbbells(
  rows: DumbbellRow[],
  t: Theme,
  unit: 'ms' | 's' = 'ms',
  fmt = ms
) {
  const max = Math.max(...rows.flatMap((r) => ORDER.map((k) => r.values[k])));
  const { top, ticks } = niceTicks(max * 1.02, 5, unit === 's' ? 1000 : 1);
  const x = (v: number) => PLOT_X + (v / top) * PLOT_W;
  const rowH = 92;
  const y0 = 70;
  const first = y0 + 50;
  const h = first + rows.length * rowH - 40;
  let svg = axis(top, ticks, unit, y0, h - 6, t);
  rows.forEach((r, i) => {
    const y = first + i * rowH;
    const xs = ORDER.map((k) => x(r.values[k]));
    svg += `<line x1="${Math.min(...xs)}" x2="${Math.max(...xs)}" y1="${y}" y2="${y}" stroke="${t.ink}" stroke-width="2.5"/>`;
    for (const k of ORDER) svg += dot(x(r.values[k]), y, k, t);
    svg += label(y + 8, r.title, r.sub);
    svg += value(y + 8, changeHead(r.values), path3(r.values, fmt));
  });
  return { svg, h };
}

/** Legend of the three markers. */
const markerLegend = (t: Theme, x: number, y: number) => {
  let out = '';
  let cx = x;
  for (const k of ORDER) {
    out += dot(cx, y, k, t, 6);
    out += `<text x="${cx + 14}" y="${y + 5}" class="legend">${NAMES[k]}</text>`;
    cx += 26 + NAMES[k].length * 8.5;
  }
  return out;
};

/** Horizontal bars, one per version, from 0. */
function bars(
  rows: {
    which: (typeof ORDER)[number];
    sub: string;
    v: number;
    note: string;
  }[],
  t: Theme,
  theme: 'light' | 'dark',
  unit: 'ms' | 's' | 'min',
  fmt: (n: number) => string,
  marker?: { at: number; label: string }
) {
  const max = Math.max(...rows.map((r) => r.v), marker?.at ?? 0);
  const { top, ticks } = niceTicks(
    max * 1.02,
    5,
    unit === 'min' ? 60_000 : unit === 's' ? 1000 : 1
  );
  const x = (v: number) => PLOT_X + (v / top) * PLOT_W;
  const y0 = 40;
  const rowH = 78;
  const first = y0 + 46;
  const end = first + rows.length * rowH - 20;
  const h = end + (marker ? 40 : 10);
  let svg = axis(top, ticks, unit, y0, end, t);
  rows.forEach((r, i) => {
    const y = first + i * rowH;
    svg += `<rect x="${PLOT_X}" y="${y - 11}" width="${Math.max(2, x(r.v) - PLOT_X)}" height="22" rx="3" fill="${BAR[theme][r.which]}"/>`;
    svg += label(y + 2, NAMES[r.which], r.sub);
    svg += value(y + 2, fmt(r.v), r.note);
  });
  if (marker) {
    svg += `<line x1="${x(marker.at)}" x2="${x(marker.at)}" y1="${y0}" y2="${end + 4}" stroke="${t.ink2}" stroke-dasharray="4 4"/>`;
    svg += `<text x="${x(marker.at)}" y="${end + 26}" text-anchor="middle" class="tick">${esc(marker.label)}</text>`;
  }
  return { svg, h };
}

function page(
  title: string,
  sections: { heading?: string; svg: string; h: number }[],
  caption: string,
  t: Theme
) {
  const body = sections
    .map(
      (s) =>
        `${s.heading ? `<h2>${esc(s.heading)}</h2>` : ''}<svg width="${WIDTH}" height="${s.h}" viewBox="0 0 ${WIDTH} ${s.h}">${s.svg}</svg>`
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:${t.bg}}
.viz-root{width:${WIDTH}px;box-sizing:border-box;padding:40px 0 32px;background:${t.bg};color:${t.ink};font-family:Geist,sans-serif;-webkit-font-smoothing:antialiased}
h1{font-size:19px;font-weight:500;margin:0 ${PAD}px 18px;letter-spacing:-0.01em}
h2{font-size:15px;font-weight:500;margin:22px ${PAD}px 0}
svg{display:block}
svg text{font-family:Geist,sans-serif;font-variant-numeric:tabular-nums;fill:${t.ink}}
svg .row{font-size:14px;font-weight:500}
svg .sub{font-size:12px;fill:${t.ink2}}
svg .tick{font-size:12px;fill:${t.ink2}}
svg .legend{font-size:12px}
.caption{font-size:13px;line-height:1.55;color:${t.ink2};margin:18px ${PAD}px 0}
.mono{font-family:"Geist Mono",monospace;font-size:12px}
</style></head><body><div class="viz-root"><h1>${esc(title)}</h1>${body}<p class="caption">${prose(caption)}</p></div></body></html>`;
}

// --- Figures ----------------------------------------------------------------------------

const p75Rows: {
  title: string;
  sub: string;
  values: Trio<number>;
  fmt: (n: number) => string;
}[] = [
  {
    title: 'Step overhead late in a long run',
    sub: 'Steps 1,001 to 1,020 of 1,020, p75',
    values: pick(D, (l) => l.late.p75),
    fmt: ms,
  },
  {
    title: 'Step-to-step overhead',
    sub: '5-step run, p75',
    values: pick(T, (l) => l.stso.p75),
    fmt: ms,
  },
  {
    title: 'Time to first step',
    sub: 'start() to the first step running, p75',
    values: pick(T, (l) => l.ttfs.p75),
    fmt: ms,
  },
  {
    title: `Delivering a ${Math.round(recording.ms / 1000)} s agent stream`,
    sub: 'Wall time, median run',
    values: pick(S, (l) => l.wall.p50),
    fmt: sec,
  },
  {
    title: 'Stream chunk trip time',
    sub: 'Writer to reader, p75',
    values: pick(S, (l) => l.ctt.p75),
    fmt: ms,
  },
  {
    title: 'Resume after 1 s idle',
    sub: 'Resume call to the next step, p75',
    values: pick(R, (l) => l.ttr.p75),
    fmt: ms,
  },
  {
    title: 'Fan-out, first branch starts',
    sub: '64 parallel branches, p75',
    values: pick(P, (l) => l.first.p75),
    fmt: ms,
  },
  {
    title: 'Fan-out, slowest branch to start',
    sub: '64 parallel branches, p75',
    values: pick(P, (l) => l.last.p75),
    fmt: ms,
  },
  {
    title: 'Fan-out join',
    sub: '64 parallel branches, p75',
    values: pick(P, (l) => l.join.p75),
    fmt: ms,
  },
  {
    title: 'Agent loop, streaming tokens',
    sub: 'Overhead of 5 turns, p75',
    values: pick(AL, (l) => l.stream.overhead.p75),
    fmt: ms,
  },
  {
    title: 'Agent loop, without streaming',
    sub: 'Overhead of 5 turns, p75',
    values: pick(AL, (l) => l.noStream.overhead.p75),
    fmt: ms,
  },
];

const verdict = (base: 'previous' | 'oldest') => {
  const slower = p75Rows.filter((r) =>
    isSlower(r.values[base], r.values.latest)
  );
  if (slower.length)
    return `faster than ${NAMES[base]} on all but ${slower.length} of ${p75Rows.length} benchmarks`;
  return p75Rows.some((r) => isSame(r.values[base], r.values.latest))
    ? `as fast as or faster than ${NAMES[base]} on every benchmark`
    : `faster than ${NAMES[base]} on every benchmark`;
};

function overview(t: Theme) {
  const rows = [...p75Rows].sort(
    (a, b) =>
      ratio(b.values.previous, b.values.latest) -
      ratio(a.values.previous, a.values.latest)
  );
  const all = rows.flatMap((r) => [
    ratio(r.values.previous, r.values.latest),
    ratio(r.values.oldest, r.values.latest),
  ]);
  const lo = Math.min(0.5, 2 ** Math.floor(Math.log2(Math.min(...all))));
  const hi = 2 ** Math.ceil(Math.log2(Math.max(...all)));
  const x = (v: number) =>
    PLOT_X +
    ((Math.log2(v) - Math.log2(lo)) / (Math.log2(hi) - Math.log2(lo))) * PLOT_W;
  const y0 = 100;
  const rowH = 74;
  const first = y0 + 46;
  const h = first + rows.length * rowH - 30;
  let svg = `<text x="${x(1) - 10}" y="${y0 - 40}" text-anchor="end" class="tick">Slower</text><text x="${x(1) + 10}" y="${y0 - 40}" class="tick">Faster</text>`;
  for (let v = lo; v <= hi; v *= 2) {
    svg += `<line x1="${x(v)}" x2="${x(v)}" y1="${y0}" y2="${h - 6}" stroke="${t.grid}"/>`;
    svg += `<text x="${x(v)}" y="${y0 - 14}" text-anchor="middle" class="tick">${v < 1 ? v : Math.round(v)}×</text>`;
  }
  rows.forEach((r, i) => {
    const y = first + i * rowH;
    const vsPrev = ratio(r.values.previous, r.values.latest);
    const vsOld = ratio(r.values.oldest, r.values.latest);
    svg += `<line x1="${x(Math.min(1, vsPrev, vsOld))}" x2="${x(Math.max(1, vsPrev, vsOld))}" y1="${y}" y2="${y}" stroke="${t.ink}" stroke-width="2.5"/>`;
    svg += dot(x(vsOld), y, 'oldest', t);
    svg += dot(x(vsPrev), y, 'latest', t);
    svg += label(y + 6, r.title, r.sub);
    svg += value(
      y + 6,
      `${change(r.values.previous, r.values.latest)} · ${change(r.values.oldest, r.values.latest)}`,
      path3(r.values, r.fmt)
    );
  });
  // Legend: what each marker compares.
  const ly = 20;
  svg +=
    dot(PLOT_X + 6, ly, 'latest', t, 6) +
    `<text x="${PLOT_X + 20}" y="${ly + 4}" class="legend">${NEW} against ${PREV}</text>`;
  svg +=
    dot(PLOT_X + 196, ly, 'oldest', t, 6) +
    `<text x="${PLOT_X + 210}" y="${ly + 4}" class="legend">${NEW} against ${OLD}</text>`;
  svg += `<text x="${VALUE_X}" y="${ly + 4}" class="legend">vs ${PREV} · vs ${OLD}</text>`;
  return page(
    (() => {
      const a = verdict('previous');
      const b = verdict('oldest');
      const both = a.replace(PREV, `${PREV} and ${OLD}`);
      return `At p75, ${NEW} is ${both === b.replace(OLD, `${PREV} and ${OLD}`) ? both : `${a}, and ${b}`}`;
    })(),
    [{ svg, h }],
    `Each marker is how many times faster ${NEW} is at p75, on a log scale, so equal distances are equal multiples. Values run ${OLD} → ${PREV} → ${NEW}. Vercel production, \`iad1\`, ${runRange()} runs per version.`,
    t
  );
}

function runRange() {
  const all = [T, D, P, R, S]
    .flatMap((w) => ORDER.map((k) => w[k].runs))
    .concat(ORDER.flatMap((k) => [AL[k].stream.runs, AL[k].noStream.runs]));
  const [a, b] = [Math.min(...all), Math.max(...all)];
  return a === b ? `${a}` : `${a} to ${b}`;
}

function sequential(t: Theme, theme: 'light' | 'dark') {
  const top = dumbbells(
    [
      {
        title: 'Time to first step',
        sub: `p75 of ${count(T.latest.ttfs.n)} runs`,
        values: pick(T, (l) => l.ttfs.p75),
      },
      ...(showP99('ttfs')
        ? [
            {
              title: 'Time to first step',
              sub: `Slowest of ${count(T.latest.ttfs.n)} runs`,
              values: pick(T, (l) => l.ttfs.p99),
            },
          ]
        : []),
      {
        title: 'Step-to-step overhead',
        sub: `p75 of ${count(T.latest.stso.n)} gaps`,
        values: pick(T, (l) => l.stso.p75),
      },
      ...(showP99('stso')
        ? [
            {
              title: 'Step-to-step overhead',
              sub: `p99 of ${count(T.latest.stso.n)} gaps`,
              values: pick(T, (l) => l.stso.p99),
            },
          ]
        : []),
    ],
    t
  );
  top.svg += markerLegend(t, PLOT_X, 18);
  // Line chart of the three windows.
  const windows = ['early', 'mid', 'late'] as const;
  const names = ['Steps 1 to 20', 'Steps 101 to 120', 'Steps 1,001 to 1,020'];
  const max = Math.max(
    ...ORDER.flatMap((k) => windows.map((w) => D[k][w].p75))
  );
  const { top: ymax, ticks } = niceTicks(max * 1.1, 4);
  const cx0 = PAD + 110;
  const cx1 = WIDTH - PAD - 80;
  const cy0 = 70;
  const cy1 = 360;
  const X = (i: number) => cx0 + (i / 2) * (cx1 - cx0);
  const Y = (v: number) => cy1 - (v / ymax) * (cy1 - cy0);
  let line = `<text x="${PAD}" y="${cy0 - 30}" class="row">p75</text>`;
  for (const v of ticks) {
    line += `<line x1="${PAD + 40}" x2="${WIDTH - PAD}" y1="${Y(v)}" y2="${Y(v)}" stroke="${t.grid}"/><text x="${PAD + 32}" y="${Y(v) + 4}" text-anchor="end" class="tick">${tickLabel(v, 'ms')}</text>`;
  }
  names.forEach((n, i) => {
    line += `<text x="${X(i)}" y="${cy1 + 52}" text-anchor="middle" class="tick">${n}</text>`;
  });
  // Label each point; put the lowest series' labels below its points so they don't collide.
  for (const k of ORDER) {
    const pts = windows.map((w, i) => [X(i), Y(D[k][w].p75)] as const);
    line += `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${k === 'previous' ? t.series.previous : t.ink}" stroke-width="2"${k === 'oldest' ? ' stroke-dasharray="6 5"' : ''}/>`;
    windows.forEach((w, i) => {
      const v = D[k][w].p75;
      const below = k === 'latest';
      line += dot(pts[i][0], pts[i][1], k, t, 6);
      line += `<text x="${pts[i][0]}" y="${pts[i][1] + (below ? 24 : -14)}" text-anchor="middle" class="legend">${ms(v)}</text>`;
    });
  }
  line += markerLegend(t, WIDTH - PAD - 330, 20);
  const wall = bars(
    ORDER.map((k) => ({
      which: k,
      sub: `Median of ${D[k].runs} runs`,
      v: D[k].wall.p50,
      note:
        k === 'latest'
          ? `${change(D.previous.wall.p50, D.latest.wall.p50)} than ${PREV}`
          : '',
    })),
    t,
    theme,
    'min',
    min
  );
  return page(
    `${NEW} at p75: ${ms(T.latest.ttfs.p75)} to the first step, ${ms(T.latest.stso.p75)} between steps, and ${ms(D.latest.late.p75)} 1,000 steps into a run`,
    [
      { heading: 'A 5-step workflow', ...top },
      {
        heading: 'Step-to-step overhead through a 1,020-step run',
        svg: line,
        h: cy1 + 70,
      },
      { heading: 'Time to finish all 1,020 steps', ...wall },
    ],
    "Time to first step runs from `start()` to the first step's first line. Step-to-step overhead runs from one step finishing to the next one starting, excluding the 100 ms of work inside each step.",
    t
  );
}

function fanout(t: Theme) {
  const d = dumbbells(
    [
      {
        title: 'First branch starts',
        sub: `p75 of ${P.latest.first.n} runs`,
        values: pick(P, (l) => l.first.p75),
      },
      {
        title: 'Slowest branch to start',
        sub: `p75 of ${P.latest.last.n} runs`,
        values: pick(P, (l) => l.last.p75),
      },
      {
        title: 'Join',
        sub: `p75 of ${P.latest.join.n} runs`,
        values: pick(P, (l) => l.join.p75),
      },
    ],
    t
  );
  d.svg += markerLegend(t, PLOT_X, 18);
  return page(
    `A 64-branch fan-out at p75: the first branch starts in ${ms(P.latest.first.p75)} on ${NEW}`,
    [d],
    "One workflow starts 64 one-step branches with `Promise.all`. First and slowest branch run from `start()` to that branch's first line; join runs from the slowest branch finishing to the code after `Promise.all`.",
    t
  );
}

function resume(t: Theme) {
  const d = dumbbells(
    [
      {
        title: 'Time to resume',
        sub: `p50 of ${count(R.latest.ttr.n)} resumes`,
        values: pick(R, (l) => l.ttr.p50),
      },
      {
        title: 'Time to resume',
        sub: `p75 of ${count(R.latest.ttr.n)} resumes`,
        values: pick(R, (l) => l.ttr.p75),
      },
    ],
    t
  );
  d.svg += markerLegend(t, PLOT_X, 18);
  return page(
    `${NEW} resumes a waiting workflow in ${ms(R.latest.ttr.p75)} at p75`,
    [d],
    'A workflow waits on a hook for 1 s, then the app calls `resumeHook()`. Time to resume runs from that call to the first line of the next step.',
    t
  );
}

function streams(t: Theme, theme: 'light' | 'dark') {
  const delivery = bars(
    ORDER.map((k) => ({
      which: k,
      sub: '',
      v: S[k].wall.p50,
      note: `${Math.round(S[k].writerChunksPerSec)} chunks per second`,
    })),
    t,
    theme,
    's',
    sec,
    { at: recording.ms, label: `Recording length, ${sec(recording.ms)}` }
  );
  const ctt = dumbbells(
    [
      {
        title: 'Chunk trip time',
        sub: 'p50 of every chunk',
        values: pick(S, (l) => l.ctt.p50),
      },
      {
        title: 'Chunk trip time',
        sub: 'p75 of every chunk',
        values: pick(S, (l) => l.ctt.p75),
      },
    ],
    t
  );
  ctt.svg += markerLegend(t, PLOT_X, 18);
  let stalls = '';
  ORDER.forEach((k, i) => {
    const y = 36 + i * 60;
    for (let j = 0; j < S[k].runs; j++) {
      const filled = j < S[k].stalledRuns;
      stalls += `<rect x="${PLOT_X + j * 26}" y="${y - 10}" width="18" height="18" rx="4" fill="${filled ? t.ink : t.bg}" stroke="${t.ink}" stroke-width="2"/>`;
    }
    stalls += label(y + 4, NAMES[k], '');
    stalls += value(y + 4, `${S[k].stalledRuns} of ${S[k].runs} runs`, '');
  });
  return page(
    `${NEW} delivers a ${sec(recording.ms)} agent stream in ${sec(S.latest.wall.p50)}`,
    [
      {
        heading: `Time to deliver a ${sec(recording.ms)} agent response`,
        ...delivery,
      },
      { heading: 'Chunk trip time', ...ctt },
      {
        heading: 'Runs with a chunk delayed by over 1 s',
        svg: stalls,
        h: 36 + ORDER.length * 60 - 20,
      },
    ],
    `A recorded agent token stream, ${count(recording.chunks)} chunks over ${sec(recording.ms)}, is replayed by one step and read by another. Chunk trip time runs from the writer writing a chunk to the reader receiving it. Median of ${S.latest.runs} runs per version.`,
    t
  );
}

function agentLoop(t: Theme) {
  const d = dumbbells(
    [
      {
        title: 'Overhead, streaming tokens',
        sub: `p75 of ${AL.latest.stream.overhead.n} runs`,
        values: pick(AL, (l) => l.stream.overhead.p75),
      },
      {
        title: 'Overhead, without streaming',
        sub: `p75 of ${AL.latest.noStream.overhead.n} runs`,
        values: pick(AL, (l) => l.noStream.overhead.p75),
      },
    ],
    t
  );
  d.svg += markerLegend(t, PLOT_X, 18);
  return page(
    `A five-turn agent loop adds ${ms(AL.latest.stream.overhead.p75)} on ${NEW} at p75`,
    [d],
    'Five model steps that stream 10 tokens each and four pairs of parallel tool steps, 100 ms of work each. Overhead runs from `start()` to the step after the last turn, minus the 900 ms of work on the critical path.',
    t
  );
}

const figures: Record<string, (t: Theme, theme: 'light' | 'dark') => string> = {
  '01-overview': overview,
  '02-sequential': sequential,
  '03-fanout': fanout,
  '04-resume': resume,
  '05-streams': streams,
  '06-agent-loop': agentLoop,
};

const htmlDir = mkdtempSync(join(tmpdir(), 'performance-figures-'));
const pages: { html: string; png: string }[] = [];
for (const [name, render] of Object.entries(figures)) {
  for (const theme of ['light', 'dark'] as const) {
    const html = join(htmlDir, `${name}-${theme}.html`);
    writeFileSync(html, render(THEMES[theme], theme));
    pages.push({ html, png: join(OUT, `${name}-${theme}.png`) });
  }
}

if (process.argv.includes('--html-only')) {
  console.log(htmlDir);
  process.exit(0);
}

const browser = (...args: string[]) => {
  const out = spawnSync('agent-browser', args, { encoding: 'utf8' });
  if (out.status !== 0)
    throw new Error(`agent-browser ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
mkdirSync(OUT, { recursive: true });
for (const { html, png } of pages) {
  browser('set', 'viewport', String(WIDTH), '400', '2');
  browser('open', `file://${html}`);
  const h = Math.ceil(
    Number(
      browser(
        'eval',
        'document.querySelector(".viz-root").getBoundingClientRect().height'
      ).replace(/[^0-9.]/g, '')
    )
  );
  browser('set', 'viewport', String(WIDTH), String(h), '2');
  browser('screenshot', png);
  console.log(`${png} ${WIDTH * 2}x${h * 2}`);
}
