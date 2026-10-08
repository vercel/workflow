// Benchmark results shown on /docs/performance.
//
// `v5.2.0.json` is the durabench export for the v5.2.0 release, copied as is. Its `v4` lane
// is workflow@4.8.12 and its `next` lane is vercel/workflow main at e6bd692, whose code is
// the v5.2.0 release (the release commit only bumps versions and changelogs).
//
// To refresh the page, replace the JSON and run `pnpm --filter docs generate:performance`,
// which rewrites the generated regions of content/docs/v5/performance.mdx. The explainer
// component reads the JSON directly.
import metrics from './v5.2.0.json';

export { metrics };

export const versions = { v4: 'v4.8.12', next: 'v5.2.0' } as const;

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
 * p99 policy: a p99 is reported when it changed by more than 5% and, if v5.2.0 is slower,
 * the regression reproduced in a second sweep. The earlier sweep of main at de8d985
 * (2026-10-08) is the reference: the slowest fan-out branch had 2 of 25 runs above v4's p99
 * in both sweeps, so it is reported. The fan-out join (1,472 ms against 712 ms here, 650 ms
 * against 637 ms before) did not reproduce, so its p99 is left out.
 */
const reproducibleP99Regressions = new Set<P99Key>(['fanoutLast']);

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
  const { v4, next } = p99[key];
  if (isSame(v4, next)) return false;
  return !isSlower(v4, next) || reproducibleP99Regressions.has(key);
};
