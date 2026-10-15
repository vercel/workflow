// The latest benchmark results shown on /docs/performance.
//
// `results.json` is the durabench export for the latest comparison, copied as is. Its `v4`
// lane is the older version and its `next` lane the newer one; `versions` names the release
// each lane stands for and `measuredOn` is the date of the sweeps.
//
// To publish new results: replace `results.json`, copy the release figures into
// public/performance/v<next version>/, and run `pnpm --filter docs generate:performance`.
// That rewrites the generated regions of content/docs/v5/performance.mdx, including the
// figure paths. The explainer animations carry no results and don't change.
import metrics from './results.json';

export { metrics };

/** Display names of the two versions compared, such as `v5.2.0`. */
export const versions = {
  v4: `v${metrics.versions.v4}`,
  next: `v${metrics.versions.next}`,
} as const;

/** The date the latest results were measured, such as "October 8, 2026". */
export const measuredOn = new Date(
  `${metrics.measuredOn}T12:00:00Z`
).toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

/** Where the release figures for the latest results live under public/. */
export const figuresPath = `/performance/${versions.next}`;

/** The recorded agent stream the streaming benchmark replays. */
export const recording = { chunks: 2593, ms: 52_377 } as const;

export const ms = (n: number) => `${Math.round(n).toLocaleString('en-US')} ms`;
export const sec = (n: number) =>
  `${(n / 1000).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} s`;
export const min = (n: number) => `${(n / 60_000).toFixed(1)} min`;
export const count = (n: number) => n.toLocaleString('en-US');

/** How many times faster `next` is than `v4`; below 1 is slower. */
export const ratio = (v4: number, next: number) => v4 / next;

/** Changes within 5% either way are reported as no change. */
export const isSame = (v4: number, next: number) =>
  Math.abs(ratio(v4, next) - 1) < 0.05;
export const isSlower = (v4: number, next: number) =>
  !isSame(v4, next) && ratio(v4, next) < 1;

export const change = (v4: number, next: number) => {
  if (isSame(v4, next)) return 'No change';
  const r = ratio(v4, next);
  return r > 1 ? `${r.toFixed(1)}× faster` : `${(1 / r).toFixed(1)}× slower`;
};

const { timing, deep, parallel, resume, stream } = metrics.workloads;

/**
 * p99 policy: the docs show a p99 only for the five-step workflow (time to first step and
 * step-to-step overhead), and only where it changed by more than 5% in the newer version's
 * favor. Every other percentile on the page is a p50 or p75.
 */
const publishedP99 = new Set<P99Key>(['ttfs', 'stso']);

export const p99 = {
  ttfs: { v4: timing.v4.ttfs.p99, next: timing.next.ttfs.p99 },
  stso: { v4: timing.v4.stso.p99, next: timing.next.stso.p99 },
  deepEarly: { v4: deep.v4.early.p99, next: deep.next.early.p99 },
  deepLate: { v4: deep.v4.late.p99, next: deep.next.late.p99 },
  fanoutFirst: { v4: parallel.v4.first.p99, next: parallel.next.first.p99 },
  fanoutLast: { v4: parallel.v4.last.p99, next: parallel.next.last.p99 },
  fanoutJoin: { v4: parallel.v4.join.p99, next: parallel.next.join.p99 },
  ttr: { v4: resume.v4.ttr.p99, next: resume.next.ttr.p99 },
  ctt: { v4: stream.v4.ctt.p99, next: stream.next.ctt.p99 },
};
export type P99Key = keyof typeof p99;

export const showP99 = (key: P99Key) => {
  if (!publishedP99.has(key)) return false;
  const { v4, next } = p99[key];
  return !isSame(v4, next) && !isSlower(v4, next);
};
