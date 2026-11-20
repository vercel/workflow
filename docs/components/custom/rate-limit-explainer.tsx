'use client';

import {
  IconPause,
  IconPlayFill,
  IconRefreshCounterClockwise,
} from '@vercel/geistdocs/assets/icons';
import { Button } from '@vercel/geistdocs/components/button';
import { CodeBlock } from '@vercel/geistdocs/components/code-block';
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Interactive explainer for `experimental_rateLimit()` on /docs/foundations/rate-limits:
 * pick a scenario or change the options, then play or scrub through runs asking a key for
 * a slot, waiting for it, going ahead, or giving up. The slots come from the same decision
 * the World makes (GCRA, below), so what the explainer draws is what a key would do.
 */

// ---------------------------------------------------------------- decision

type Options = {
  limit: number;
  /** Fixed at one second, so a slot's offset reads as milliseconds. */
  periodMs: number;
  burst: number;
  /** `null` for no `maxWait`. */
  maxWaitMs: number | null;
};

type Call = {
  run: number;
  /** When the run asks for a slot. */
  askAt: number;
  /** The slot it gets, or would have had. */
  slotAt: number;
  rejected: boolean;
  /** The key's next free slot (GCRA's `tat`) right after this call was decided. */
  tatAfter: number | undefined;
};

/**
 * GCRA, as the World decides each call: a call's slot is `max(now, tat - τ)`, and a call
 * that gets one moves `tat` to `max(tat, now) + T`. A call whose slot is past its
 * `maxWait` is refused and moves nothing.
 */
function decide(options: Options, asks: number[]): Call[] {
  const T = options.periodMs / options.limit;
  const tolerance = (options.burst - 1) * T;
  let tat: number | undefined;
  return asks.map((askAt, run) => {
    const slotAt = tat === undefined ? askAt : Math.max(askAt, tat - tolerance);
    if (options.maxWaitMs !== null && slotAt - askAt > options.maxWaitMs) {
      return { run, askAt, slotAt, rejected: true, tatAfter: tat };
    }
    tat = Math.max(tat ?? askAt, askAt) + T;
    return { run, askAt, slotAt, rejected: false, tatAfter: tat };
  });
}

// ---------------------------------------------------------------- scenarios

type Arrivals = 'together' | 'spread';

type Scenario = {
  id: string;
  name: string;
  title: string;
  definition: string;
  options: Options;
  calls: number;
  arrivals: Arrivals;
};

const PERIOD_MS = 1000;
const SPREAD = [0, 90, 160, 720, 1380, 1440, 1500, 2300, 2350, 2400];

const scenarios: Scenario[] = [
  {
    id: 'spacing',
    name: 'Spacing',
    title: 'Calls go ahead one interval apart',
    definition:
      'Six runs ask at once. The key hands out slots `period / limit` apart: the first goes ahead now, and each of the others waits for its own slot, like a `sleep()`.',
    options: { limit: 4, periodMs: PERIOD_MS, burst: 1, maxWaitMs: null },
    calls: 6,
    arrivals: 'together',
  },
  {
    id: 'burst',
    name: 'Burst',
    title: 'An idle key lets a burst through at once',
    definition:
      'With `burst: 4`, the key saves up four calls while it is idle. Four runs go ahead at once, then the key refills one call every `period / limit`.',
    options: { limit: 4, periodMs: PERIOD_MS, burst: 4, maxWaitMs: null },
    calls: 6,
    arrivals: 'together',
  },
  {
    id: 'max-wait',
    name: 'maxWait',
    title: 'Give up instead of waiting too long',
    definition:
      'With `maxWait: "500ms"`, a run whose slot is further out rejects at once with `RateLimitMaxWaitError`. It reserves nothing, so the runs after it are not pushed back.',
    options: { limit: 4, periodMs: PERIOD_MS, burst: 1, maxWaitMs: 500 },
    calls: 6,
    arrivals: 'together',
  },
  {
    id: 'over-time',
    name: 'Over time',
    title: 'An idle key admits a call at once',
    definition:
      'Runs ask at different times. A run that asks after the key has caught up goes ahead at once; only runs that ask close together wait.',
    options: { limit: 4, periodMs: PERIOD_MS, burst: 1, maxWaitMs: null },
    calls: 7,
    arrivals: 'spread',
  },
];

const asksFor = (calls: number, arrivals: Arrivals) =>
  arrivals === 'together'
    ? Array.from({ length: calls }, () => 0)
    : SPREAD.slice(0, calls);

const msLabel = (ms: number) =>
  ms >= 1000 ? `${Number((ms / 1000).toFixed(2))}s` : `${Math.round(ms)}ms`;

/**
 * The call the options make, as highlighted tokens: one line, so it is
 * tokenized here rather than by Shiki, in the same token colors as the docs'
 * code blocks.
 */
const callTokens = (o: Options): { text: string; color?: string }[] => {
  const keyword = 'var(--shiki-token-keyword)';
  const fn = 'var(--shiki-token-function)';
  const string = 'var(--shiki-token-string)';
  const number = 'var(--shiki-token-constant)';
  const punct = 'var(--shiki-token-punctuation)';
  const fields: [string, string | number][] = [
    ['key', 'api'],
    ['limit', o.limit],
    ['period', '1s'],
    ...(o.burst > 1 ? [['burst', o.burst] as [string, number]] : []),
    ...(o.maxWaitMs !== null
      ? [['maxWait', msLabel(o.maxWaitMs)] as [string, string]]
      : []),
  ];
  const tokens: { text: string; color?: string }[] = [
    { text: 'await', color: keyword },
    { text: ' ' },
    { text: 'experimental_rateLimit', color: fn },
    { text: '({ ', color: punct },
  ];
  fields.forEach(([name, value], i) => {
    if (i > 0) tokens.push({ text: ', ', color: punct });
    tokens.push({ text: name }, { text: ': ', color: punct });
    tokens.push(
      typeof value === 'number'
        ? { text: String(value), color: number }
        : { text: `"${value}"`, color: string }
    );
  });
  tokens.push({ text: ' });', color: punct });
  return tokens;
};

// ---------------------------------------------------------------- drawing

// Geist steps for each mark, as inline styles so they follow the light and dark themes.
const colors = {
  primary: 'var(--ds-gray-1000)',
  secondary: 'var(--ds-gray-900)',
  work: 'var(--ds-gray-800)',
  // The accent, as in the Workflow SDK 5 explainers: what the key lets go.
  accent: 'var(--ds-blue-800)',
  accentStrong: 'var(--ds-blue-900)',
  band: 'var(--ds-blue-200)',
  gridline: 'var(--ds-gray-alpha-300)',
  guide: 'var(--ds-gray-alpha-700)',
  playhead: 'var(--ds-blue-700)',
  halo: 'var(--ds-background-100)',
};
const strokeBase: CSSProperties = {
  fill: 'none',
  strokeWidth: 1,
  vectorEffect: 'non-scaling-stroke',
};
const gridline: CSSProperties = { ...strokeBase, stroke: colors.gridline };
const guide: CSSProperties = {
  ...strokeBase,
  stroke: colors.guide,
  strokeDasharray: '3 3',
};
const wait: CSSProperties = {
  ...strokeBase,
  stroke: colors.secondary,
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeDasharray: '8 4',
};
const halo: CSSProperties = {
  paintOrder: 'stroke',
  stroke: colors.halo,
  strokeWidth: 5,
  strokeLinejoin: 'round',
};
const textStyles = {
  plain: { ...halo, fill: colors.secondary, fontSize: 12 },
  lane: { ...halo, fill: colors.primary, fontSize: 12 },
  strong: { ...halo, fill: colors.primary, fontSize: 12, fontWeight: 500 },
} satisfies Record<string, CSSProperties>;

const Label = ({
  x,
  y,
  children,
  kind = 'plain',
  anchor = 'start',
}: {
  x: number;
  y: number;
  children: ReactNode;
  kind?: keyof typeof textStyles;
  anchor?: 'start' | 'middle' | 'end';
}) => (
  <text style={textStyles[kind]} textAnchor={anchor} x={x} y={y}>
    {children}
  </text>
);

/** How long a run's call to the upstream is drawn for once it goes ahead. */
const WORK_MS = 120;

function Timeline({
  calls,
  options,
  horizonMs,
  nowMs,
  width,
}: {
  calls: Call[];
  options: Options;
  horizonMs: number;
  nowMs: number;
  width: number;
}) {
  const labelLane = 92;
  const plotStart = labelLane + 16;
  const plotEnd = width - 16;
  const laneH = 34;
  const keyTop = 8;
  const lanesTop = keyTop + laneH + 10;
  const axisY = lanesTop + calls.length * laneH + 14;
  const height = axisY + 22;
  const x = (ms: number) =>
    plotStart + (Math.min(ms, horizonMs) / horizonMs) * (plotEnd - plotStart);
  const laneY = (lane: number) => lanesTop + lane * laneH + laneH / 2;
  const keyY = keyTop + laneH / 2;
  const T = options.periodMs / options.limit;
  const tolerance = (options.burst - 1) * T;

  // The key's next free slot at the playhead: set by the last call decided by then.
  const decided = calls.filter((c) => c.askAt <= nowMs);
  const tat = decided.length ? decided[decided.length - 1].tatAfter : undefined;
  const marks: ReactNode[] = [];

  // Key lane: slots handed out so far, and the next free slot with its burst tolerance.
  marks.push(
    <Label key="key-label" kind="lane" x={0} y={keyY + 4}>
      Key "api"
    </Label>,
    <line
      key="key-grid"
      style={gridline}
      x1={plotStart}
      x2={plotEnd}
      y1={keyY + laneH / 2}
      y2={keyY + laneH / 2}
    />
  );
  // Slots handed out so far, one tick each.
  for (const call of calls) {
    if (call.rejected || call.slotAt > nowMs || call.askAt > nowMs) continue;
    marks.push(
      <rect
        height={12}
        key={`key-slot-${call.run}`}
        rx={1}
        style={{ fill: colors.accent }}
        width={3}
        x={x(call.slotAt) - 1.5}
        y={keyY - 6}
      />
    );
  }
  if (tat !== undefined) {
    const shown = Math.max(tat, nowMs);
    const from = Math.max(shown - tolerance, 0);
    if (tolerance > 0) {
      const bandWidth = Math.max(0, x(shown) - x(from));
      marks.push(
        <rect
          height={18}
          key="key-band"
          rx={3}
          style={{ fill: colors.band }}
          width={bandWidth}
          x={x(from)}
          y={keyY - 9}
        />
      );
      if (bandWidth > 56) {
        marks.push(
          <Label
            anchor="middle"
            key="key-band-label"
            x={(x(from) + x(shown)) / 2}
            y={keyY + 4}
          >
            burst
          </Label>
        );
      }
    }
    // Beside the marker, or before the band when the marker is near the end.
    const nearEnd = x(shown) > plotEnd - 150;
    marks.push(
      <path
        d={`M ${x(shown)} ${keyY - 7} l 6 7 l -6 7 l -6 -7 z`}
        key="key-tat"
        style={{ fill: colors.accentStrong }}
      />,
      <Label
        anchor={nearEnd ? 'end' : 'start'}
        key="key-tat-label"
        kind="strong"
        x={nearEnd ? x(tolerance > 0 ? from : shown) - 10 : x(shown) + 10}
        y={keyY + 4}
      >
        {`next free slot ${msLabel(tat)}`}
      </Label>
    );
  }

  calls.forEach((call, lane) => {
    const y = laneY(lane);
    marks.push(
      <Label key={`lane-${call.run}`} kind="lane" x={0} y={y + 4}>
        Run {call.run + 1}
      </Label>,
      <line
        key={`grid-${call.run}`}
        style={gridline}
        x1={plotStart}
        x2={plotEnd}
        y1={y + laneH / 2}
        y2={y + laneH / 2}
      />
    );
    if (nowMs < call.askAt) return;
    if (!call.rejected)
      marks.push(
        <circle
          cx={x(call.askAt)}
          cy={y}
          key={`ask-${call.run}`}
          r={4}
          style={{
            fill: colors.halo,
            stroke: colors.primary,
            strokeWidth: 1.5,
          }}
        />
      );
    if (call.rejected) {
      const cx = x(call.askAt);
      marks.push(
        <path
          d={`M ${cx - 5} ${y - 5} L ${cx + 5} ${y + 5} M ${cx + 5} ${y - 5} L ${cx - 5} ${y + 5}`}
          key={`reject-${call.run}`}
          style={{
            ...strokeBase,
            stroke: colors.primary,
            strokeWidth: 2,
            strokeLinecap: 'round',
          }}
        />,
        <Label key={`reject-label-${call.run}`} x={cx + 12} y={y + 4}>
          {`slot in ${msLabel(call.slotAt - call.askAt)}: RateLimitMaxWaitError`}
        </Label>
      );
      return;
    }
    if (call.slotAt > call.askAt) {
      marks.push(
        <line
          key={`wait-${call.run}`}
          style={wait}
          x1={x(call.askAt) + 6}
          x2={Math.max(x(call.askAt) + 6, x(Math.min(call.slotAt, nowMs)))}
          y1={y}
          y2={y}
        />
      );
    }
    if (nowMs >= call.slotAt) {
      const end = Math.min(call.slotAt + WORK_MS, nowMs);
      marks.push(
        <rect
          height={14}
          key={`go-${call.run}`}
          rx={2}
          style={{ fill: colors.accent }}
          width={Math.max(1.5, x(end) - x(call.slotAt))}
          x={x(call.slotAt)}
          y={y - 7}
        />,
        <Label
          key={`go-label-${call.run}`}
          x={x(call.slotAt + WORK_MS) + 8}
          y={y + 4}
        >
          {call.slotAt > call.askAt
            ? `waited ${msLabel(call.slotAt - call.askAt)}`
            : 'went ahead at once'}
        </Label>
      );
    }
  });

  // Axis: one tick per interval up to the horizon, labelled each period.
  const ticks: ReactNode[] = [];
  for (let ms = 0; ms <= horizonMs + 0.5; ms += T) {
    const atPeriod =
      Math.abs(ms / options.periodMs - Math.round(ms / options.periodMs)) <
      1e-6;
    ticks.push(
      <line
        key={`tick-${ms}`}
        style={atPeriod ? guide : gridline}
        x1={x(ms)}
        x2={x(ms)}
        y1={axisY - 6}
        y2={axisY}
      />
    );
    if (atPeriod) {
      ticks.push(
        <Label
          anchor="middle"
          key={`tick-label-${ms}`}
          x={x(ms)}
          y={axisY + 14}
        >
          {msLabel(ms)}
        </Label>
      );
    }
  }

  return (
    <svg
      aria-hidden="true"
      className="block h-auto max-w-none font-sans"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <line
        style={gridline}
        x1={plotStart}
        x2={plotEnd}
        y1={axisY - 6}
        y2={axisY - 6}
      />
      {ticks}
      {marks}
      {nowMs < horizonMs ? (
        <line
          style={{ ...strokeBase, stroke: colors.playhead }}
          x1={x(nowMs)}
          x2={x(nowMs)}
          y1={keyTop}
          y2={axisY - 6}
        />
      ) : null}
    </svg>
  );
}

// ---------------------------------------------------------------- controls

/** How long one play-through takes. */
const PLAY_MS = 6000;
const MIN_TIMELINE_WIDTH = 520;

const Inline = ({ text }: { text: string }) => (
  <>
    {text.split('`').map((part, i) =>
      i % 2 ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: static text segments
        <code key={i}>{part}</code>
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: static text segments
        <span key={i}>{part}</span>
      )
    )}
  </>
);

const usePrefersReducedMotion = () => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
};

const useWidth = <T extends HTMLElement>(fallback: number) => {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
};

const Select = ({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) => (
  <div className="flex flex-col gap-1">
    <label className="text-gray-900 text-label-13" htmlFor={id}>
      {label}
    </label>
    <select
      className="h-8 rounded-md border border-gray-alpha-400 bg-background-100 px-2 font-mono text-[13px] text-gray-1000"
      id={id}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </div>
);

/** What the key has done by `nowMs`, for screen readers and the status line. */
const describe = (calls: Call[], options: Options, nowMs: number) => {
  const asked = calls.filter((c) => c.askAt <= nowMs);
  const went = asked.filter((c) => !c.rejected && c.slotAt <= nowMs);
  const waiting = asked.filter((c) => !c.rejected && c.slotAt > nowMs);
  const rejected = asked.filter((c) => c.rejected);
  const lastPeriod = went.filter(
    (c) => c.slotAt > nowMs - options.periodMs
  ).length;
  const gaveUp = rejected.length ? `, ${rejected.length} gave up` : '';
  return `At ${msLabel(nowMs)}: ${went.length} went ahead (${lastPeriod} in the last second), ${waiting.length} waiting${gaveUp}.`;
};

export const RateLimitExplainer = () => {
  const id = useId();
  const [index, setIndex] = useState(0);
  const [options, setOptions] = useState<Options>(scenarios[0].options);
  const [calls, setCalls] = useState(scenarios[0].calls);
  const [arrivals, setArrivals] = useState<Arrivals>(scenarios[0].arrivals);
  const [t, setT] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const [timelineRef, timelineWidth] = useWidth<HTMLDivElement>(640);
  const frame = useRef(0);
  const scenario = scenarios[index];

  const decidedCalls = useMemo(
    () => decide(options, asksFor(calls, arrivals)),
    [options, calls, arrivals]
  );
  const horizonMs = useMemo(() => {
    const last = Math.max(
      ...decidedCalls.map((c) =>
        c.rejected ? c.askAt + 400 : c.slotAt + WORK_MS + 380
      )
    );
    return Math.ceil(last / 250) * 250;
  }, [decidedCalls]);
  const nowMs = (t / 100) * horizonMs;

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    setPlaying(false);
  }, []);
  useEffect(() => stop, [stop]);

  const play = () => {
    if (playing) {
      stop();
      return;
    }
    // With reduced motion, jump to the finished run instead of animating it.
    if (reducedMotion) {
      setT(100);
      setPlayed(true);
      return;
    }
    let from = t >= 100 ? 0 : t;
    let prev = performance.now();
    setT(from);
    setPlaying(true);
    const tick = (now: number) => {
      from = Math.min(100, from + ((now - prev) / PLAY_MS) * 100);
      prev = now;
      setT(from);
      if (from < 100) {
        frame.current = requestAnimationFrame(tick);
      } else {
        frame.current = 0;
        setPlaying(false);
        setPlayed(true);
      }
    };
    frame.current = requestAnimationFrame(tick);
  };

  const select = (next: number) => {
    stop();
    setIndex(next);
    setOptions(scenarios[next].options);
    setCalls(scenarios[next].calls);
    setArrivals(scenarios[next].arrivals);
    setT(100);
    setPlayed(false);
  };
  const change = (patch: Partial<Options>) => {
    stop();
    setOptions((o) => ({ ...o, ...patch }));
    setT(100);
  };

  const status = describe(decidedCalls, options, nowMs);
  const playLabel = playing ? 'Pause' : t >= 100 && played ? 'Replay' : 'Play';
  const PlayIcon = playing
    ? IconPause
    : t >= 100 && played
      ? IconRefreshCounterClockwise
      : IconPlayFill;
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).map(
      (v) => ({ value: v, label: v })
    );

  return (
    <figure
      aria-labelledby={`${id}-title`}
      className="not-prose my-8 flex flex-col gap-6 rounded-lg border border-gray-400 bg-background-100 p-4 sm:p-6"
    >
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Scenario</legend>
        {scenarios.map((s, i) => (
          <Button
            aria-pressed={i === index}
            key={s.id}
            onClick={() => select(i)}
            size="small"
            variant={i === index ? 'default' : 'secondary'}
          >
            {s.name}
          </Button>
        ))}
      </fieldset>

      <div className="flex flex-col gap-2">
        <p
          className="m-0 font-semibold text-gray-1000 text-heading-20"
          id={`${id}-title`}
        >
          {scenario.title}
        </p>
        <p className="m-0 text-copy-14 text-gray-900 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-gray-1000">
          <Inline text={scenario.definition} />
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        <Select
          id={`${id}-limit`}
          label="limit (per 1s)"
          onChange={(v) => change({ limit: Number(v) })}
          options={range(1, 8)}
          value={String(options.limit)}
        />
        <Select
          id={`${id}-burst`}
          label="burst"
          onChange={(v) => change({ burst: Number(v) })}
          options={range(1, 8)}
          value={String(options.burst)}
        />
        <Select
          id={`${id}-max-wait`}
          label="maxWait"
          onChange={(v) =>
            change({ maxWaitMs: v === 'none' ? null : Number(v) })
          }
          options={[
            { value: 'none', label: 'none' },
            { value: '250', label: '250ms' },
            { value: '500', label: '500ms' },
            { value: '1000', label: '1s' },
          ]}
          value={
            options.maxWaitMs === null ? 'none' : String(options.maxWaitMs)
          }
        />
        <Select
          id={`${id}-calls`}
          label="runs"
          onChange={(v) => {
            stop();
            setCalls(Number(v));
            setT(100);
          }}
          options={range(2, 10)}
          value={String(calls)}
        />
        <Select
          id={`${id}-arrivals`}
          label="runs ask"
          onChange={(v) => {
            stop();
            setArrivals(v as Arrivals);
            setT(100);
          }}
          options={[
            { value: 'together', label: 'at once' },
            { value: 'spread', label: 'over time' },
          ]}
          value={arrivals}
        />
      </div>

      <CodeBlock className="my-0! min-w-0">
        {[
          <Fragment key="call">
            <span className="line">
              {callTokens(options).map((token, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens never reorder
                  key={i}
                  style={token.color ? { color: token.color } : undefined}
                >
                  {token.text}
                </span>
              ))}
            </span>
          </Fragment>,
        ]}
      </CodeBlock>

      <div className="min-w-0 overflow-x-auto" ref={timelineRef}>
        <Timeline
          calls={decidedCalls}
          horizonMs={horizonMs}
          nowMs={nowMs}
          options={options}
          width={Math.max(MIN_TIMELINE_WIDTH, timelineWidth)}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <Button
          className="self-start"
          onClick={play}
          prefix={<PlayIcon size={16} />}
          size="small"
          variant="secondary"
        >
          {playLabel}
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label
            className="text-gray-900 text-label-13"
            htmlFor={`${id}-scrub`}
          >
            Timeline
          </label>
          <input
            aria-valuetext={status}
            className="w-full accent-[var(--ds-blue-800)]"
            id={`${id}-scrub`}
            max={100}
            min={0}
            onChange={(event) => {
              stop();
              setT(Number(event.target.value));
            }}
            step={0.5}
            type="range"
            value={t}
          />
        </div>
      </div>

      <p aria-live="polite" className="-mt-3 m-0 text-copy-13 text-gray-900">
        {status}
      </p>

      <figcaption className="flex flex-col gap-1 text-copy-13 text-gray-900">
        <span>
          Slots come from GCRA, the decision every World that supports rate
          limits makes. Each run is drawn as going ahead at its slot; a real run
          can wake a little after it.
        </span>
      </figcaption>
    </figure>
  );
};
