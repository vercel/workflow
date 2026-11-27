/**
 * Rewrites the generated regions of content/docs/v5/performance.mdx from the benchmark
 * results in lib/performance. Every measured number on the page comes from here, so a new
 * set of results only needs a new JSON file and a re-run.
 *
 *   bun ./scripts/generate-performance.ts           # rewrite the page
 *   bun ./scripts/generate-performance.ts --check   # exit 1 if the page is out of date
 *
 * A region is the Markdown between `{/* generated:performance <name> *\/}` and
 * `{/* end generated:performance <name> *\/}`. Prose outside the regions is not touched. A
 * region written on a single line is filled inline; any other region gets its own blocks.
 * The release figures' paths are pointed at the folder for the latest results, too.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  change,
  count,
  figuresPath,
  isSame,
  isSlower,
  lanes,
  measuredOn,
  metrics,
  min,
  ms,
  type P99Key,
  p99,
  pick,
  ratio,
  recording,
  sec,
  showP99,
  type Trio,
  versions,
} from '../lib/performance';

const PAGE = fileURLToPath(
  new URL('../content/docs/v5/performance.mdx', import.meta.url)
);

const T = lanes('timing');
const D = lanes('deep');
const P = lanes('parallel');
const R = lanes('resume');
const S = lanes('stream');
const AL = lanes('agentLoop');
const { oldest: OLD, previous: PREV, latest: NEW } = versions;

type Format = (n: number) => string;

const list = (items: string[]) =>
  items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** "X on the latest, Y on the previous and Z on the oldest version". */
const across = (t: Trio<number>, fmt: Format = ms) =>
  `${fmt(t.latest)} on ${NEW}, ${fmt(t.previous)} on ${PREV} and ${fmt(t.oldest)} on ${OLD}`;

/** "N unit", or "A, B and C unit" (oldest first) when the versions differ. */
const samples = (t: Trio<number>, unit: string) => {
  const all = [t.oldest, t.previous, t.latest];
  return `${list((all.every((n) => n === t.latest) ? [t.latest] : all).map(count))} ${unit}`;
};

// --- Headline -------------------------------------------------------------------------

const p75Rows: { name: string; values: Trio<number>; fmt?: Format }[] = [
  { name: 'time to first step', values: pick(T, (l) => l.ttfs.p75) },
  { name: 'step-to-step overhead', values: pick(T, (l) => l.stso.p75) },
  {
    name: 'step overhead late in a long run',
    values: pick(D, (l) => l.late.p75),
  },
  { name: 'stream delivery', values: pick(S, (l) => l.wall.p50), fmt: sec },
  { name: 'chunk trip time', values: pick(S, (l) => l.ctt.p75) },
  { name: 'time to resume', values: pick(R, (l) => l.ttr.p75) },
  { name: 'the first fan-out branch', values: pick(P, (l) => l.first.p75) },
  {
    name: 'the slowest fan-out branch to start',
    values: pick(P, (l) => l.last.p75),
  },
  { name: 'the fan-out join', values: pick(P, (l) => l.join.p75) },
  {
    name: 'the streaming agent loop',
    values: pick(AL, (l) => l.stream.overhead.p75),
  },
  {
    name: 'the agent loop without streaming',
    values: pick(AL, (l) => l.noStream.overhead.p75),
  },
];

/** How the latest version compares with `base` across every p75 row. */
const verdict = (base: 'previous' | 'oldest', name: string) => {
  const slower = p75Rows.filter((r) =>
    isSlower(r.values[base], r.values.latest)
  );
  const same = p75Rows.filter((r) => isSame(r.values[base], r.values.latest));
  if (slower.length)
    return `faster than ${name} on every benchmark except ${list(slower.map((r) => r.name))}`;
  return same.length
    ? `as fast as or faster than ${name} on every benchmark`
    : `faster than ${name} on every benchmark`;
};

const largest = p75Rows.reduce((a, b) =>
  ratio(b.values.previous, b.values.latest) >
  ratio(a.values.previous, a.values.latest)
    ? b
    : a
);

const vsPrev = verdict('previous', PREV);
const vsOld = verdict('oldest', OLD);
// When both comparisons read the same, name both versions in one clause.
const together = vsPrev.replace(PREV, `${PREV} and ${OLD}`);
const headline = [
  `At p75, ${NEW} is ${together === vsOld.replace(OLD, `${PREV} and ${OLD}`) ? together : `${vsPrev}, and ${vsOld}`}.`,
  `The largest change from ${PREV} is in ${largest.name}: ${across(largest.values, largest.fmt)}.`,
].join(' ');

// --- Sections -------------------------------------------------------------------------

const sequential = `At p75, a five-step workflow reaches its first step in ${across(pick(T, (l) => l.ttfs.p75))}. Between steps, it adds ${across(pick(T, (l) => l.stso.p75))}.`;

/** "grows from A in steps 1 to 20 to B in steps 1,001 to 1,020" or "stays at about A". */
const trend = (lane: (typeof D)['latest']) =>
  isSame(lane.early.p75, lane.late.p75)
    ? `stays at about ${ms(lane.late.p75)}`
    : `${lane.late.p75 > lane.early.p75 ? 'grows' : 'falls'} from ${ms(lane.early.p75)} to ${ms(lane.late.p75)}`;

const longRun = `Through a 1,020-step run, from steps 1 to 20 to steps 1,001 to 1,020, step-to-step overhead at p75 ${trend(D.oldest)} on ${OLD}, ${trend(D.previous)} on ${PREV}, and ${trend(D.latest)} on ${NEW}. The median run takes ${across(
  pick(D, (l) => l.wall.p50),
  min
)}.`;

const fanout = [
  `At p75, the first of 64 branches starts in ${across(pick(P, (l) => l.first.p75))}. The slowest branch starts in ${across(pick(P, (l) => l.last.p75))}, and the join takes ${across(pick(P, (l) => l.join.p75))}.`,
  isSlower(p99.fanoutLast.previous, p99.fanoutLast.latest)
    ? `At p99, the slowest branch starts later on ${NEW} than on ${PREV}: ${ms(p99.fanoutLast.latest)} against ${ms(p99.fanoutLast.previous)}.`
    : '',
]
  .filter(Boolean)
  .join(' ');

const resume = `At p75, a workflow waiting on a hook resumes in ${across(pick(R, (l) => l.ttr.p75))}${
  showP99('ttr') ? `, and at p99 in ${across(pick(R, (l) => l.ttr.p99))}` : ''
}.`;

/** A writer that keeps up delivers within 5% of the recording's chunk rate. */
const recordingRate = (recording.chunks / recording.ms) * 1000;
const keptUp = (lane: (typeof S)['latest']) =>
  lane.writerChunksPerSec >= recordingRate * 0.95;
const streamLanes = [
  { name: OLD, lane: S.oldest },
  { name: PREV, lane: S.previous },
  { name: NEW, lane: S.latest },
];
const behind = streamLanes.filter((v) => !keptUp(v.lane));
const kept = streamLanes.filter((v) => keptUp(v.lane));

const streams = [
  [
    `The agent produced its ${count(recording.chunks)}-chunk response over ${sec(recording.ms)}.`,
    ...behind.map(
      (v) =>
        `On ${v.name} the writer step manages about ${Math.round(v.lane.writerChunksPerSec)} chunks per second, so the response takes ${sec(v.lane.wall.p50)} to reach the reader.`
    ),
    kept.length
      ? `${list(kept.map((v) => v.name))} ${kept.length > 1 ? 'write' : 'writes'} streams over a WebSocket by default, ${kept.length > 1 ? 'keep' : 'keeps'} up at about ${Math.round(kept[0].lane.writerChunksPerSec)} chunks per second, and ${kept.length > 1 ? 'deliver' : 'delivers'} the response in ${list(kept.map((v) => `${sec(v.lane.wall.p50)}${kept.length > 1 ? ` on ${v.name}` : ''}`))}.`
      : '',
  ]
    .filter(Boolean)
    .join(' '),
  `At p75, a chunk reaches the reader in ${across(pick(S, (l) => l.ctt.p75))}. A chunk was delayed by over 1 s in ${list(
    [S.latest, S.previous, S.oldest].map(
      (l, i) => `${l.stalledRuns} of ${l.runs} runs on ${[NEW, PREV, OLD][i]}`
    )
  )}.`,
].join('\n\n');

// --- Agent loop -----------------------------------------------------------------------

const agentLoop = [
  `The loop runs on a benchmark app of its own, deployed once per version, and each version ran it ${AL.latest.stream.runs} times with streaming and ${AL.latest.noStream.runs} times without.`,
  `At p75, the five-turn loop that streams its tokens adds ${across(pick(AL, (l) => l.stream.overhead.p75))}. Without streaming, ${NEW} adds ${ms(AL.latest.noStream.overhead.p75)}, of which ${ms(AL.latest.noStream.firstStep.p75)} is the time to reach the first step (at p75), against ${ms(AL.previous.noStream.overhead.p75)} on ${PREV} and ${ms(AL.oldest.noStream.overhead.p75)} on ${OLD}.`,
  `On ${NEW}, the streaming loop waits after each model step until its last tokens are stored: the tools start ${ms(AL.latest.stream.modelToTools.p75)} after the model step at p75, against ${ms(AL.latest.noStream.modelToTools.p75)} without streaming.`,
].join('\n\n');

// --- Results table --------------------------------------------------------------------

const row = (label: string, t: Trio<number>, n: string, fmt: Format = ms) =>
  `| ${label} | ${fmt(t.oldest)} | ${fmt(t.previous)} | ${fmt(t.latest)} | ${change(t.previous, t.latest)} | ${change(t.oldest, t.latest)} | ${n} |`;
const p99Row = (key: P99Key, label: string, n: string) =>
  showP99(key) ? [row(label, p99[key], n)] : [];
const group = (title: string, rows: string[]) => [
  `| **${title}** | | | | | | |`,
  ...rows,
];
const runs = (t: Trio<{ runs: number }>) =>
  samples(
    pick(t, (l) => l.runs),
    'runs'
  );

const table = [
  `| Metric | ${OLD} | ${PREV} | ${NEW} | ${NEW} vs ${PREV} | ${NEW} vs ${OLD} | Samples per version |`,
  '| --- | --: | --: | --: | --: | --: | --: |',
  ...group(`Sequential workflow, 5 steps, ${runs(T)}`, [
    row(
      'Time to first step, p75',
      pick(T, (l) => l.ttfs.p75),
      samples(
        pick(T, (l) => l.ttfs.n),
        'runs'
      )
    ),
    ...p99Row(
      'ttfs',
      'Time to first step, slowest run',
      samples(
        pick(T, (l) => l.ttfs.n),
        'runs'
      )
    ),
    row(
      'Step-to-step overhead, p75',
      pick(T, (l) => l.stso.p75),
      samples(
        pick(T, (l) => l.stso.n),
        'gaps'
      )
    ),
    ...p99Row(
      'stso',
      'Step-to-step overhead, p99',
      samples(
        pick(T, (l) => l.stso.n),
        'gaps'
      )
    ),
  ]),
  ...group(`Long run, 1,020 steps, ${runs(D)}`, [
    row(
      'Step overhead, steps 1 to 20, p75',
      pick(D, (l) => l.early.p75),
      samples(
        pick(D, (l) => l.early.n),
        'gaps'
      )
    ),
    ...p99Row(
      'deepEarly',
      'Step overhead, steps 1 to 20, p99',
      samples(
        pick(D, (l) => l.early.n),
        'gaps'
      )
    ),
    row(
      'Step overhead, steps 101 to 120, p75',
      pick(D, (l) => l.mid.p75),
      samples(
        pick(D, (l) => l.mid.n),
        'gaps'
      )
    ),
    row(
      'Step overhead, steps 1,001 to 1,020, p75',
      pick(D, (l) => l.late.p75),
      samples(
        pick(D, (l) => l.late.n),
        'gaps'
      )
    ),
    ...p99Row(
      'deepLate',
      'Step overhead, steps 1,001 to 1,020, p99',
      samples(
        pick(D, (l) => l.late.n),
        'gaps'
      )
    ),
    row(
      'Whole run, median wall time',
      pick(D, (l) => l.wall.p50),
      runs(D),
      min
    ),
  ]),
  ...group(`Fan-out, 64 parallel branches, ${runs(P)}`, [
    row(
      'First branch starts, p75',
      pick(P, (l) => l.first.p75),
      samples(
        pick(P, (l) => l.first.n),
        'runs'
      )
    ),
    ...p99Row(
      'fanoutFirst',
      'First branch starts, p99',
      samples(
        pick(P, (l) => l.first.n),
        'runs'
      )
    ),
    row(
      'Slowest branch to start, p75',
      pick(P, (l) => l.last.p75),
      samples(
        pick(P, (l) => l.last.n),
        'runs'
      )
    ),
    ...p99Row(
      'fanoutLast',
      'Slowest branch to start, p99',
      samples(
        pick(P, (l) => l.last.n),
        'runs'
      )
    ),
    row(
      'Join, p75',
      pick(P, (l) => l.join.p75),
      samples(
        pick(P, (l) => l.join.n),
        'runs'
      )
    ),
    ...p99Row(
      'fanoutJoin',
      'Join, p99',
      samples(
        pick(P, (l) => l.join.n),
        'runs'
      )
    ),
  ]),
  ...group(`Resume after 1 s idle, ${runs(R)} of 5 resumes`, [
    row(
      'Time to resume, p50',
      pick(R, (l) => l.ttr.p50),
      samples(
        pick(R, (l) => l.ttr.n),
        'resumes'
      )
    ),
    row(
      'Time to resume, p75',
      pick(R, (l) => l.ttr.p75),
      samples(
        pick(R, (l) => l.ttr.n),
        'resumes'
      )
    ),
    ...p99Row(
      'ttr',
      'Time to resume, p99',
      samples(
        pick(R, (l) => l.ttr.n),
        'resumes'
      )
    ),
  ]),
  ...group(`Agent stream, ${sec(recording.ms)} recording, ${runs(S)}`, [
    row(
      'Delivery, median wall time',
      pick(S, (l) => l.wall.p50),
      runs(S),
      sec
    ),
    row(
      'Chunk trip time, p75',
      pick(S, (l) => l.ctt.p75),
      samples(
        pick(S, (l) => l.ctt.n),
        'chunks'
      )
    ),
    ...p99Row(
      'ctt',
      'Chunk trip time, p99',
      samples(
        pick(S, (l) => l.ctt.n),
        'chunks'
      )
    ),
  ]),
  ...(['stream', 'noStream'] as const).flatMap((mode) =>
    group(
      `Agent loop, 5 turns, ${mode === 'stream' ? 'streaming tokens' : 'without streaming'}, ${samples(
        pick(AL, (l) => l[mode].runs),
        'runs'
      )}`,
      [
        row(
          'Overhead, p50',
          pick(AL, (l) => l[mode].overhead.p50),
          samples(
            pick(AL, (l) => l[mode].overhead.n),
            'runs'
          )
        ),
        row(
          'Overhead, p75',
          pick(AL, (l) => l[mode].overhead.p75),
          samples(
            pick(AL, (l) => l[mode].overhead.n),
            'runs'
          )
        ),
        row(
          'Model step to tools, p75',
          pick(AL, (l) => l[mode].modelToTools.p75),
          samples(
            pick(AL, (l) => l[mode].modelToTools.n),
            'turns'
          )
        ),
      ]
    )
  ),
].join('\n');

// --- Latest results ---------------------------------------------------------------------

const latest = `**Latest results:** Workflow SDK ${NEW} compared with ${PREV} and ${OLD}, measured ${measuredOn}. We run these benchmarks regularly and publish updated results here.`;

const timesEach = (t: Trio<{ runs: number }>) => {
  const r = pick(t, (l) => l.runs);
  return r.oldest === r.latest && r.previous === r.latest
    ? `${count(r.latest)} times`
    : `${samples(r, 'times')} (${OLD}, ${PREV} and ${NEW})`;
};

const runsPerVersion = `Each version ran the sequential workflow ${timesEach(T)}, the agent stream ${timesEach(S)}, the fan-out ${timesEach(P)}, the resume benchmark ${timesEach(R)}, the 1,020-step run ${timesEach(D)}, and the agent loop ${timesEach(pick3(AL, 'stream'))} with streaming and ${timesEach(pick3(AL, 'noStream'))} without.`;

function pick3(t: typeof AL, mode: 'stream' | 'noStream') {
  return {
    oldest: t.oldest[mode],
    previous: t.previous[mode],
    latest: t.latest[mode],
  };
}

const caveats = [
  'All three versions ran at the same time and shared the platform.',
  ...metrics.notes,
  runsPerVersion,
].join(' ');

const regions: Record<string, string> = {
  latest,
  headline,
  caveats,
  sequential,
  'long-run': longRun,
  fanout,
  resume,
  streams,
  'agent-loop': agentLoop,
  table,
};

// --- Rewrite --------------------------------------------------------------------------

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const before = await readFile(PAGE, 'utf8');
let after = before;
for (const [name, body] of Object.entries(regions)) {
  const start = `{/* generated:performance ${name} */}`;
  const end = `{/* end generated:performance ${name} */}`;
  const pattern = new RegExp(
    `${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`
  );
  if (!pattern.test(after)) {
    console.error(`performance.mdx has no "${name}" region`);
    process.exit(1);
  }
  // A region written on one line, such as inside a list item, stays inline.
  const inline = !pattern.exec(after)?.[0].includes('\n');
  after = after.replace(pattern, () =>
    inline ? `${start}${body}${end}` : `${start}\n\n${body}\n\n${end}`
  );
}

// Point the release figures at the latest results' folder, sized as rendered.
after = after.replace(
  /(src(?:Light|Dark)=")\/performance\/v[^/"]+\//g,
  `$1${figuresPath}/`
);
const pngSize = async (publicPath: string) => {
  const file = await readFile(
    fileURLToPath(new URL(`../public${publicPath}`, import.meta.url))
  );
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
};
for (const match of after.matchAll(
  /<Image\s+srcLight="(\/performance\/[^"]+\.png)"[\s\S]*?\/>/g
)) {
  const { width, height } = await pngSize(match[1]);
  const sized = match[0]
    .replace(/width=\{\d+\}/, `width={${width}}`)
    .replace(/height=\{\d+\}/, `height={${height}}`);
  after = after.replace(match[0], sized);
}

if (process.argv.includes('--check')) {
  if (after !== before) {
    console.error(
      'performance.mdx is out of date. Run `pnpm --filter docs generate:performance`.'
    );
    process.exit(1);
  }
  console.log('performance.mdx is up to date.');
} else {
  await writeFile(PAGE, after);
  console.log(
    after === before
      ? 'performance.mdx is already up to date.'
      : 'Updated performance.mdx.'
  );
}
