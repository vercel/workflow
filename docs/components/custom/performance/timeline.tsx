import type { CSSProperties, ReactNode } from 'react';
import type { Bracket, MetricModel, TimelineItem } from './models';

// Geist steps for each mark. Inline styles so they follow the light and dark theme tokens.
const colors = {
  primary: 'var(--ds-gray-1000)',
  secondary: 'var(--ds-gray-900)',
  work: 'var(--ds-gray-800)',
  gridline: 'var(--ds-gray-alpha-300)',
  guide: 'var(--ds-gray-alpha-700)',
  playhead: 'var(--ds-gray-alpha-600)',
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
const series: CSSProperties = {
  ...strokeBase,
  stroke: colors.primary,
  strokeWidth: 2,
  strokeLinecap: 'round',
};
const wait: CSSProperties = {
  ...series,
  stroke: colors.secondary,
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
  bracket: {
    ...halo,
    fill: colors.primary,
    fontSize: 14,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
  },
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

type Layout = ReturnType<typeof layout>;

const layout = (model: MetricModel, width: number) => {
  const labelLane = 92;
  const plotStart = labelLane + 16;
  const plotEnd = width - 12;
  const rows = Math.max(...model.brackets.map((b) => b.row)) + 1;
  const top = 10;
  const bracketRow = 34;
  const laneH = 34;
  const lanesTop = top + rows * bracketRow + 6;
  return {
    plotStart,
    plotEnd,
    laneH,
    lanesTop,
    height: lanesTop + model.lanes.length * laneH + 6,
    x: (u: number) => plotStart + (u / 100) * (plotEnd - plotStart),
    laneY: (lane: number) => lanesTop + lane * laneH + laneH / 2,
    bracketY: (row: number) => top + row * bracketRow + 24,
  };
};

/** A label beside a mark, on the side the model asks for. */
const sideLabel = (
  key: string,
  side: 'left' | 'right' | undefined,
  x: number,
  y: number,
  gap: number,
  text: string
) => (
  <Label
    anchor={side === 'left' ? 'end' : 'start'}
    key={key}
    x={side === 'left' ? x - gap : x + gap}
    y={y}
  >
    {text}
  </Label>
);

type Item<T extends TimelineItem['type']> = Extract<TimelineItem, { type: T }>;
type Draw<T extends TimelineItem['type']> = (
  it: Item<T>,
  key: string,
  t: number,
  L: Layout
) => ReactNode[];

/** A chunk's trip from the writer lane down to the reader lane. */
const drawTrip: Draw<'trip'> = (it, key, t, { x, laneY }) => {
  if (t <= it.from) return [];
  const end = Math.min(it.to, t);
  const y0 = laneY(0) + 6;
  const y1 = laneY(1) - 6;
  return [
    <line
      key={key}
      style={guide}
      x1={x(it.from)}
      x2={x(end)}
      y1={y0}
      y2={y0 + (y1 - y0) * ((end - it.from) / (it.to - it.from))}
    />,
  ];
};

/** A step's work (tall, gray) or the workflow running (short, solid). */
const drawBar: Draw<'work' | 'run'> = (it, key, t, { x, laneY }) => {
  if (t <= it.from) return [];
  const y = laneY(it.lane);
  const h = it.type === 'work' ? 14 : 8;
  const at = it.labelAt ?? (it.side === 'left' ? it.from : it.to);
  return [
    <rect
      height={h}
      key={key}
      rx={2}
      style={{ fill: it.type === 'work' ? colors.work : colors.primary }}
      width={Math.max(1.5, x(Math.min(it.to, t)) - x(it.from))}
      x={x(it.from)}
      y={y - h / 2}
    />,
    it.label && t >= it.to
      ? sideLabel(`${key}-label`, it.side, x(at), y + 4, 8, it.label)
      : null,
  ];
};

/** The workflow waiting, as a dashed line. */
const drawWait: Draw<'wait'> = (it, key, t, { x, laneY }) => {
  if (t <= it.from) return [];
  const y = laneY(it.lane);
  const mid = (it.from + it.to) / 2;
  return [
    <line
      key={key}
      style={wait}
      x1={x(it.from)}
      x2={x(Math.min(it.to, t))}
      y1={y}
      y2={y}
    />,
    it.label && t >= mid ? (
      <Label anchor="middle" key={`${key}-label`} x={x(mid)} y={y - 8}>
        {it.label}
      </Label>
    ) : null,
  ];
};

/** A call from your app, such as `start()`. */
const drawPoint: Draw<'point'> = (it, key, t, { x, laneY }) => {
  if (t < it.at) return [];
  const y = laneY(it.lane);
  return [
    <circle
      cx={x(it.at)}
      cy={y}
      key={key}
      r={5}
      style={{ fill: colors.primary }}
    />,
    it.label
      ? sideLabel(`${key}-label`, it.side, x(it.at), y + 4, 10, it.label)
      : null,
  ];
};

/** A stream chunk written or read. */
const drawTick: Draw<'tick'> = (it, key, t, { x, laneY }) =>
  t < it.at
    ? []
    : [
        <rect
          height={14}
          key={key}
          rx={1}
          style={{ fill: colors.primary }}
          width={3}
          x={x(it.at) - 1.5}
          y={laneY(it.lane) - 7}
        />,
      ];

/** The marks one timeline item contributes at playhead `t`. */
const itemMarks = (
  it: TimelineItem,
  i: number,
  t: number,
  L: Layout
): ReactNode[] => {
  const key = `item-${i}`;
  switch (it.type) {
    case 'trip':
      return drawTrip(it, key, t, L);
    case 'work':
    case 'run':
      return drawBar(it, key, t, L);
    case 'wait':
      return drawWait(it, key, t, L);
    case 'point':
      return drawPoint(it, key, t, L);
    case 'tick':
      return drawTick(it, key, t, L);
  }
};

/** The guides from a bracket down to the lanes it measures. Drawn behind every mark. */
const guideMarks = (
  b: Bracket,
  i: number,
  t: number,
  { x, laneY, bracketY }: Layout
): ReactNode[] => {
  if (t <= b.from) return [];
  const y = bracketY(b.row);
  return [
    <line
      key={`guide-${i}-from`}
      style={guide}
      x1={x(b.from)}
      x2={x(b.from)}
      y1={y}
      y2={laneY(b.guides[0])}
    />,
    t >= b.to ? (
      <line
        key={`guide-${i}-to`}
        style={guide}
        x1={x(b.to)}
        x2={x(b.to)}
        y1={y}
        y2={laneY(b.guides[1])}
      />
    ) : null,
  ];
};

const bracketMarks = (
  b: Bracket,
  i: number,
  t: number,
  model: MetricModel,
  { x, bracketY }: Layout
): ReactNode[] => {
  if (t <= b.from) return [];
  const y = bracketY(b.row);
  const tick = (at: number, key: string) => (
    <line
      key={key}
      style={series}
      x1={x(at)}
      x2={x(at)}
      y1={y - 5}
      y2={y + 5}
    />
  );
  // Centre the label on its bracket unless a guide from a bracket above would cross it;
  // then start it just right of its own start tick.
  const half = (b.label.length * 7.6) / 2 + 4;
  const cx = (x(b.from) + x(b.to)) / 2;
  const crossed = model.brackets.some(
    (o) =>
      o.row < b.row && [o.from, o.to].some((g) => Math.abs(x(g) - cx) < half)
  );
  return [
    <line
      key={`bracket-${i}`}
      style={series}
      x1={x(b.from)}
      x2={x(Math.min(b.to, t))}
      y1={y}
      y2={y}
    />,
    tick(b.from, `bracket-${i}-from`),
    t >= b.to ? tick(b.to, `bracket-${i}-to`) : null,
    <Label
      anchor={crossed ? 'start' : 'middle'}
      key={`bracket-${i}-label`}
      kind="bracket"
      x={crossed ? x(b.from) + 6 : cx}
      y={y - 8}
    >
      {b.label}
    </Label>,
  ];
};

/**
 * A schematic timeline of one benchmark run, drawn up to the playhead `t` (0 to 100). At
 * `t = 100` the whole run is drawn and the playhead is hidden.
 */
export const Timeline = ({
  model,
  width,
  t,
}: {
  model: MetricModel;
  width: number;
  t: number;
}) => {
  const L = layout(model, width);
  // Trips are drawn first so the ticks they connect sit on top of them.
  const trips = model.items.filter((it) => it.type === 'trip');
  const others = model.items.filter((it) => it.type !== 'trip');
  return (
    <svg
      aria-hidden="true"
      className="block h-auto max-w-none font-sans"
      height={L.height}
      viewBox={`0 0 ${width} ${L.height}`}
      width={width}
    >
      {model.lanes.map((name, lane) => (
        <g key={name}>
          <Label kind="lane" x={0} y={L.laneY(lane) + 4}>
            {name}
          </Label>
          <line
            style={gridline}
            x1={L.plotStart}
            x2={L.plotEnd}
            y1={L.laneY(lane) + L.laneH / 2}
            y2={L.laneY(lane) + L.laneH / 2}
          />
        </g>
      ))}
      {model.brackets.flatMap((b, i) => guideMarks(b, i, t, L))}
      {trips.flatMap((it, i) => itemMarks(it, i, t, L))}
      {others.flatMap((it, i) => itemMarks(it, trips.length + i, t, L))}
      {model.brackets.flatMap((b, i) => bracketMarks(b, i, t, model, L))}
      {t < 100 ? (
        <line
          style={{ ...strokeBase, stroke: colors.playhead }}
          x1={L.x(t)}
          x2={L.x(t)}
          y1={L.lanesTop - 4}
          y2={L.height - 4}
        />
      ) : null}
    </svg>
  );
};
