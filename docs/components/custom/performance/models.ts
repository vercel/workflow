// One model per benchmark metric: the code a run executes, where its clock starts and stops,
// and a schematic timeline. Ported from the durabench explainer builder
// (research/v5-launch/vbg/explainers/build.mjs) so the docs explainer, the release figures,
// and the animations in public/performance/explainers draw the same thing.
//
// Time runs from 0 to 100 in schematic units. `at` on a code line lists the ranges during
// which that line is the one running, which drives the playhead highlight.
import { metrics } from '@/lib/performance';

export type TimeRange = [from: number, to: number];

export type CodeLine = {
  /** Source text of the line. */
  s: string;
  /** Lines that start or stop a clock render in bold. */
  mark?: boolean;
  at?: TimeRange[];
};

export type TimelineItem =
  | {
      type: 'work' | 'run';
      lane: number;
      from: number;
      to: number;
      label?: string;
      side?: 'left' | 'right';
      labelAt?: number;
    }
  | { type: 'wait'; lane: number; from: number; to: number; label?: string }
  | {
      type: 'point';
      lane: number;
      at: number;
      label?: string;
      side?: 'left' | 'right';
    }
  | { type: 'tick'; lane: number; at: number }
  | { type: 'trip'; from: number; to: number };

export type Bracket = {
  from: number;
  to: number;
  /** Bracket rows stack above the lanes, row 0 on top. */
  row: number;
  label: string;
  /** The lanes the bracket's start and end guides drop to. */
  guides: [from: number, to: number];
};

export type MetricResult = { label: string; v4: number; next: number };

export type MetricModel = {
  id: 'ttfs' | 'stso' | 'fanout' | 'resume' | 'stream';
  name: string;
  acronym: string;
  /** Plain text; `backticks` render as inline code. */
  definition: string;
  code: CodeLine[];
  lanes: string[];
  items: TimelineItem[];
  brackets: Bracket[];
  /** p75 results, v4.8.12 against v5.2.0. */
  results: MetricResult[];
  note?: string;
};

const { timing, deep, parallel, resume, stream } = metrics.workloads;

/** Stream chunks as [written at, trip time] on the schematic clock. */
const CHUNKS: [number, number][] = [
  [5, 5],
  [9, 6],
  [14, 5],
  [20, 6],
  [31, 7],
  [35, 5],
  [39, 6],
  [45, 5],
  [51, 7],
  [55, 5],
  [63, 6],
  [70, 5],
  [74, 9],
  [82, 5],
  [88, 6],
  [93, 5],
];

/** Each timestamp line lights briefly as a chunk passes it. */
const pulse = (times: number[]): TimeRange[] =>
  times.map((at) => [at, at + 1.5]);

export const models: MetricModel[] = [
  {
    id: 'ttfs',
    name: 'Time to first step',
    acronym: 'TTFS',
    definition:
      "How long it takes from your app calling `start()` until the first line of the workflow's first step runs. It covers creating and queuing the run, running the workflow code up to its first step, and starting that step.",
    code: [
      { s: '// Your app' },
      {
        s: 'const t0 = Date.now()        // clock starts',
        mark: true,
        at: [[0, 6]],
      },
      { s: 'await start(myWorkflow, input)', at: [[3, 18]] },
      { s: '' },
      { s: 'export async function myWorkflow(input) {', at: [[18, 36]] },
      { s: '  "use workflow"', at: [[18, 36]] },
      { s: '  await firstStep(input)', at: [[30, 52]] },
      { s: '}' },
      { s: '' },
      { s: 'async function firstStep(input) {', at: [[52, 100]] },
      { s: '  "use step"', at: [[52, 100]] },
      {
        s: '  const t1 = Date.now()      // clock stops',
        mark: true,
        at: [[52, 58]],
      },
      { s: '  await doWork()', at: [[58, 100]] },
      { s: '}' },
    ],
    lanes: ['Your app', 'Workflow', 'Step 1'],
    items: [
      { type: 'point', lane: 0, at: 4, label: 'start()', side: 'right' },
      {
        type: 'run',
        lane: 1,
        from: 20,
        to: 34,
        label: 'runs to the first step',
        side: 'right',
      },
      {
        type: 'work',
        lane: 2,
        from: 52,
        to: 98,
        label: 'first line runs',
        side: 'left',
        labelAt: 52,
      },
    ],
    brackets: [
      { from: 4, to: 52, row: 0, label: 'Time to first step', guides: [0, 2] },
    ],
    results: [
      {
        label: 'Time to first step',
        v4: timing.v4.ttfs.p75,
        next: timing.next.ttfs.p75,
      },
    ],
  },
  {
    id: 'stso',
    name: 'Step-to-step overhead',
    acronym: 'STSO',
    definition:
      "How long it takes from one step finishing until the next step starts. Each step does 100 ms of simulated work inside its own clock, which is not counted, so the gap is the runtime's own overhead: recording the step's result, resuming the workflow, and starting the next step.",
    code: [
      { s: 'export async function myWorkflow(input) {' },
      { s: '  "use workflow"' },
      { s: '  let data = input' },
      { s: '  for (let i = 0; i < 5; i++) {' },
      {
        s: '    data = await step(data)',
        at: [
          [28, 40],
          [64, 74],
        ],
      },
      { s: '  }' },
      { s: '}' },
      { s: '' },
      { s: 'async function step(data) {' },
      { s: '  "use step"' },
      {
        s: '  const at = Date.now()       // gap ends',
        mark: true,
        at: [
          [40, 43],
          [74, 77],
        ],
      },
      {
        s: '  await doWork(100)           // not counted',
        at: [
          [4, 26],
          [43, 62],
          [77, 98],
        ],
      },
      {
        s: '  const endAt = Date.now()    // gap starts',
        mark: true,
        at: [
          [26, 28],
          [62, 64],
        ],
      },
      { s: '  return next(data)' },
      { s: '}' },
    ],
    lanes: ['Workflow', 'Step 1', 'Step 2', 'Step 3'],
    items: [
      { type: 'work', lane: 1, from: 4, to: 28 },
      { type: 'run', lane: 0, from: 31, to: 37 },
      { type: 'work', lane: 2, from: 40, to: 64 },
      { type: 'run', lane: 0, from: 67, to: 72 },
      { type: 'work', lane: 3, from: 74, to: 98 },
    ],
    brackets: [
      { from: 28, to: 40, row: 0, label: 'Overhead', guides: [1, 2] },
      { from: 64, to: 74, row: 0, label: 'Overhead', guides: [2, 3] },
    ],
    results: [
      {
        label: '5-step run',
        v4: timing.v4.stso.p75,
        next: timing.next.stso.p75,
      },
      {
        label: 'Steps 1,001 to 1,020 of a 1,020-step run',
        v4: deep.v4.late.p75,
        next: deep.next.late.p75,
      },
    ],
    note: 'The long-run benchmark measures the same gap at steps 1 to 20, 101 to 120, and 1,001 to 1,020 of one 1,020-step run.',
  },
  {
    id: 'fanout',
    name: 'Fan-out',
    acronym: 'TTFS, TTLS, join',
    definition:
      'A workflow starts 64 steps at once with `Promise.all`. First branch and slowest branch measure how long it takes, from your app calling `start()`, until the first line of the first branch to start, and of the slowest, runs. Join measures how long it takes, after the slowest branch finishes, until the code after `Promise.all` runs.',
    code: [
      {
        s: 'const t0 = Date.now()        // clock starts',
        mark: true,
        at: [[0, 5]],
      },
      { s: 'await start(fanOut)', at: [[2, 8]] },
      { s: '' },
      { s: 'export async function fanOut() {', at: [[8, 16]] },
      { s: '  "use workflow"', at: [[8, 16]] },
      { s: '  await Promise.all(', at: [[14, 72]] },
      { s: '    branches.map((b) => branch(b)))', at: [[14, 42]] },
      { s: '  await afterJoin()', at: [[72, 80]] },
      { s: '}' },
      { s: '' },
      { s: 'async function branch(b) {', at: [[22, 70]] },
      { s: '  "use step"', at: [[22, 70]] },
      {
        s: '  const at = Date.now()      // first, slowest',
        mark: true,
        at: [
          [22, 23.5],
          [26, 27.5],
          [30, 31.5],
          [42, 43.5],
        ],
      },
      { s: '  await doWork(100)', at: [[23, 70]] },
      { s: '}' },
      { s: '' },
      { s: 'async function afterJoin() {', at: [[80, 100]] },
      { s: '  "use step"', at: [[80, 100]] },
      {
        s: '  const at = Date.now()      // join ends',
        mark: true,
        at: [[80, 84]],
      },
      { s: '}' },
    ],
    // Branches are queued in batches, so they start close together and in no fixed order
    // (in a typical v5.2.0 run, 3 at once and the other 61 within about 370 ms), not as a
    // staircase.
    lanes: [
      'Your app',
      'Workflow',
      'Branch 1',
      'Branch 2',
      'Branch 3',
      '…',
      'Branch 64',
      'After join',
    ],
    items: [
      { type: 'point', lane: 0, at: 2, label: 'start()', side: 'right' },
      { type: 'run', lane: 1, from: 8, to: 15 },
      { type: 'work', lane: 2, from: 22, to: 48 },
      { type: 'work', lane: 3, from: 30, to: 56 },
      { type: 'work', lane: 4, from: 42, to: 70 },
      { type: 'work', lane: 6, from: 26, to: 52 },
      { type: 'run', lane: 1, from: 72, to: 77 },
      { type: 'work', lane: 7, from: 80, to: 92 },
    ],
    brackets: [
      {
        from: 2,
        to: 42,
        row: 0,
        label: 'Slowest branch (TTLS)',
        guides: [0, 4],
      },
      { from: 2, to: 22, row: 1, label: 'First branch (TTFS)', guides: [0, 2] },
      { from: 70, to: 80, row: 1, label: 'Join', guides: [4, 7] },
    ],
    results: [
      {
        label: 'First branch starts',
        v4: parallel.v4.first.p75,
        next: parallel.next.first.p75,
      },
      {
        label: 'Slowest branch to start',
        v4: parallel.v4.last.p75,
        next: parallel.next.last.p75,
      },
      { label: 'Join', v4: parallel.v4.join.p75, next: parallel.next.join.p75 },
    ],
    note: 'Branches start close together and in no fixed order. Each branch does 100 ms of simulated work.',
  },
  {
    id: 'resume',
    name: 'Time to resume',
    acronym: 'TTR',
    definition:
      "A workflow waits on a hook, idle for 1 s, the way an agent waits for a person's approval. Time to resume measures how long it takes from your app calling `resumeHook()` until the first line of the next step runs.",
    code: [
      { s: 'export async function approval() {', at: [[2, 12]] },
      { s: '  "use workflow"', at: [[2, 12]] },
      { s: '  const hook = createHook({ token })', at: [[2, 8]] },
      { s: '  const event = await hook    // 1 s idle', at: [[8, 66]] },
      { s: '  await nextStep(event)', at: [[66, 80]] },
      { s: '}' },
      { s: '' },
      { s: 'async function nextStep(event) {', at: [[80, 100]] },
      { s: '  "use step"', at: [[80, 100]] },
      {
        s: '  const wokeAt = Date.now()   // clock stops',
        mark: true,
        at: [[80, 86]],
      },
      { s: '}' },
      { s: '' },
      { s: '// Your app, 1 s later' },
      {
        s: 'const sentAt = Date.now()    // clock starts',
        mark: true,
        at: [[60, 64]],
      },
      { s: 'await resumeHook(token, { sentAt })', at: [[62, 68]] },
    ],
    lanes: ['Workflow', 'Your app', 'Next step'],
    items: [
      { type: 'run', lane: 0, from: 2, to: 10 },
      {
        type: 'wait',
        lane: 0,
        from: 10,
        to: 64,
        label: 'waiting on the hook, 1 s',
      },
      { type: 'point', lane: 1, at: 62, label: 'resumeHook()', side: 'left' },
      { type: 'run', lane: 0, from: 66, to: 73 },
      { type: 'work', lane: 2, from: 80, to: 98 },
    ],
    brackets: [
      { from: 62, to: 80, row: 0, label: 'Time to resume', guides: [1, 2] },
    ],
    results: [
      {
        label: 'Time to resume',
        v4: resume.v4.ttr.p75,
        next: resume.next.ttr.p75,
      },
    ],
  },
  {
    id: 'stream',
    name: 'Stream chunk trip time',
    acronym: 'CTT',
    definition:
      "One step replays a recorded AI agent's token stream, 2,593 chunks over 52.4 s, while another step reads it. Chunk trip time measures how long each chunk takes from the writer writing it until the reader receives it.",
    code: [
      { s: 'export async function agentStream() {' },
      { s: '  "use workflow"' },
      { s: '  await Promise.all([writer(), reader()])' },
      { s: '}' },
      { s: '' },
      { s: 'async function writer() {' },
      { s: '  "use step"' },
      { s: '  const out = getWritable().getWriter()' },
      { s: '  for (const chunk of recording) {', at: [[0, 100]] },
      {
        s: '    const writtenAt = Date.now() // starts',
        mark: true,
        at: pulse(CHUNKS.map(([at]) => at)),
      },
      { s: '    await out.write({ ...chunk, writtenAt })' },
      { s: '  }' },
      { s: '}' },
      { s: '' },
      { s: 'async function reader() {' },
      { s: '  "use step"' },
      { s: '  for await (const chunk of readable) {', at: [[0, 100]] },
      {
        s: '    const readAt = Date.now()    // stops',
        mark: true,
        at: pulse(CHUNKS.map(([at, trip]) => at + trip)),
      },
      { s: '  }' },
      { s: '}' },
    ],
    lanes: ['Writer step', 'Reader step'],
    items: CHUNKS.flatMap(([at, trip]): TimelineItem[] => [
      { type: 'tick', lane: 0, at },
      { type: 'tick', lane: 1, at: at + trip },
      { type: 'trip', from: at, to: at + trip },
    ]),
    brackets: [
      { from: 20, to: 26, row: 0, label: 'Chunk trip time', guides: [0, 1] },
    ],
    results: [
      {
        label: 'Chunk trip time',
        v4: stream.v4.ctt.p75,
        next: stream.next.ctt.p75,
      },
    ],
    note: "Both clocks are read inside the same deployment's steps.",
  },
];

export const modelTitle = (model: MetricModel) =>
  `${model.name} (${model.acronym})`;
