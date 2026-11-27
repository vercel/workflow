// The latest benchmark results shown on /docs/performance.
//
// `results.json` holds the latest campaign: every workload measured on each version in
// `versions` (oldest first), with each lane's pooled percentiles. `measuredOn` is the date
// of the campaign and `notes` lists anything that ran differently from the methodology.
//
// To publish new results: replace `results.json`, render the release figures into
// public/performance/v<latest version>/ (`pnpm --filter docs render:performance-figures`),
// and run `pnpm --filter docs generate:performance`. That rewrites the generated regions
// of content/docs/v5/performance.mdx, including the figure paths. The explainer
// animations carry no results and don't change.
import metrics from './results.json';

export { metrics };

/** A pooled percentile summary: `n` samples, nearest-rank p50, p75 and p99. */
export type Stat = { n: number; p50: number; p75: number; p99: number };

/** The npm versions compared, oldest first, such as `5.2.0`. */
export const releases = metrics.versions as [string, string, string];
const [OLDEST_RELEASE, PREVIOUS_RELEASE, LATEST_RELEASE] = releases;

/** Display names: the oldest (the last v4), the previous v5 release, and the latest. */
export const versions = {
  oldest: `v${OLDEST_RELEASE}`,
  previous: `v${PREVIOUS_RELEASE}`,
  latest: `v${LATEST_RELEASE}`,
} as const;

type Lane = { label: string; sdk: string; runs: number };
export type Lanes = {
  timing: Lane & { ttfs: Stat; stso: Stat };
  deep: Lane & { early: Stat; mid: Stat; late: Stat; wall: Stat };
  parallel: Lane & { first: Stat; last: Stat; join: Stat };
  resume: Lane & { ttr: Stat };
  stream: Lane & {
    ctt: Stat;
    wall: Stat;
    writerChunksPerSec: number;
    stalledRuns: number;
  };
  agentLoop: Record<
    'stream' | 'noStream',
    { runs: number; overhead: Stat; modelToTools: Stat; firstStep: Stat }
  >;
};

/** A workload's lane on each version. */
export type Trio<T> = { oldest: T; previous: T; latest: T };

/** One lane per version of a workload. */
export const lanes = <K extends keyof Lanes>(workload: K): Trio<Lanes[K]> => {
  const byVersion = metrics.workloads[workload] as unknown as Record<
    string,
    Lanes[K]
  >;
  return {
    oldest: byVersion[OLDEST_RELEASE],
    previous: byVersion[PREVIOUS_RELEASE],
    latest: byVersion[LATEST_RELEASE],
  };
};

/** The same value picked from each version's lane. */
export const pick = <T>(of: Trio<T>, value: (lane: T) => number) => ({
  oldest: value(of.oldest),
  previous: value(of.previous),
  latest: value(of.latest),
});

const longDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** The date the latest results were measured, such as "November 27, 2026". */
export const measuredOn = longDate(metrics.measuredOn);

/** Where the release figures for the latest results live under public/. */
export const figuresPath = `/performance/${versions.latest}`;

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

/** How many times faster `newer` is than `older`; below 1 is slower. */
export const ratio = (older: number, newer: number) => older / newer;

/** Changes within 5% either way are reported as no change. */
export const isSame = (older: number, newer: number) =>
  Math.abs(ratio(older, newer) - 1) < 0.05;
export const isSlower = (older: number, newer: number) =>
  !isSame(older, newer) && ratio(older, newer) < 1;

export const change = (older: number, newer: number) => {
  if (isSame(older, newer)) return 'No change';
  const r = ratio(older, newer);
  return r > 1 ? `${r.toFixed(1)}× faster` : `${(1 / r).toFixed(1)}× slower`;
};

const timing = lanes('timing');
const deep = lanes('deep');
const parallel = lanes('parallel');
const resume = lanes('resume');
const stream = lanes('stream');

/**
 * p99 policy: the docs show a p99 only for the five-step workflow (time to first step and
 * step-to-step overhead), and only where the latest version is not slower than the
 * previous one by more than 5%. Every other percentile on the page is a p50 or p75.
 */
const publishedP99 = new Set<P99Key>(['ttfs', 'stso']);

export const p99 = {
  ttfs: pick(timing, (l) => l.ttfs.p99),
  stso: pick(timing, (l) => l.stso.p99),
  deepEarly: pick(deep, (l) => l.early.p99),
  deepLate: pick(deep, (l) => l.late.p99),
  fanoutFirst: pick(parallel, (l) => l.first.p99),
  fanoutLast: pick(parallel, (l) => l.last.p99),
  fanoutJoin: pick(parallel, (l) => l.join.p99),
  ttr: pick(resume, (l) => l.ttr.p99),
  ctt: pick(stream, (l) => l.ctt.p99),
};
export type P99Key = keyof typeof p99;

export const showP99 = (key: P99Key) => {
  if (!publishedP99.has(key)) return false;
  const { previous, latest } = p99[key];
  return !isSlower(previous, latest);
};
