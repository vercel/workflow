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
  measuredOn,
  metrics,
  min,
  ms,
  type P99Key,
  p99,
  recording,
  sec,
  showP99,
  versions,
} from '../lib/performance';

const PAGE = fileURLToPath(
  new URL('../content/docs/v5/performance.mdx', import.meta.url)
);

const {
  timing: T,
  deep: D,
  parallel: P,
  resume: R,
  stream: S,
} = metrics.workloads;
const OLD = versions.v4;
const NEW = versions.next;

const list = (items: string[]) =>
  items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** "N unit", or "A and B unit" when the two versions differ, v4 first. */
const samples = (a: number, b: number, unit: string) =>
  `${(a === b ? [b] : [a, b]).map(count).join(' and ')} ${unit}`;

// --- Headline -------------------------------------------------------------------------

const p75Rows = [
  { name: 'time to first step', v4: T.v4.ttfs.p75, next: T.next.ttfs.p75 },
  { name: 'step-to-step overhead', v4: T.v4.stso.p75, next: T.next.stso.p75 },
  {
    name: 'step overhead late in a long run',
    v4: D.v4.late.p75,
    next: D.next.late.p75,
  },
  {
    name: 'stream delivery',
    v4: S.v4.wall.p50,
    next: S.next.wall.p50,
  },
  { name: 'chunk trip time', v4: S.v4.ctt.p75, next: S.next.ctt.p75 },
  { name: 'time to resume', v4: R.v4.ttr.p75, next: R.next.ttr.p75 },
  {
    name: 'the first fan-out branch',
    v4: P.v4.first.p75,
    next: P.next.first.p75,
  },
  {
    name: 'the slowest fan-out branch to start',
    v4: P.v4.last.p75,
    next: P.next.last.p75,
  },
  { name: 'the fan-out join', v4: P.v4.join.p75, next: P.next.join.p75 },
];
const slowerAtP75 = p75Rows.filter((r) => isSlower(r.v4, r.next));
const sameAtP75 = p75Rows.filter((r) => isSame(r.v4, r.next));

const headline = [
  slowerAtP75.length
    ? `At p75, ${NEW} is faster than ${OLD} on every benchmark except ${list(slowerAtP75.map((r) => r.name))}.`
    : sameAtP75.length
      ? `At p75, ${NEW} is as fast as or faster than ${OLD} on every benchmark.`
      : `At p75, ${NEW} is faster than ${OLD} on every benchmark.`,
  `The largest change is in long runs: 1,000 steps into a run, ${NEW} adds ${ms(D.next.late.p75)} between steps where ${OLD} adds ${ms(D.v4.late.p75)}.`,
].join(' ');

// --- Sections -------------------------------------------------------------------------

const sequential = `At p75, a five-step workflow reaches its first step in ${ms(T.next.ttfs.p75)} on ${NEW} and ${ms(T.v4.ttfs.p75)} on ${OLD}, and ${NEW} adds ${ms(T.next.stso.p75)} between steps where ${OLD} adds ${ms(T.v4.stso.p75)}.`;

const longRun = `Through a 1,020-step run, step-to-step overhead on ${OLD} grows from ${ms(D.v4.early.p75)} in steps 1 to 20 to ${ms(D.v4.late.p75)} in steps 1,001 to 1,020, at p75. On ${NEW} it is ${ms(D.next.early.p75)} and ${ms(D.next.late.p75)}. The median run takes ${min(D.v4.wall.p50)} on ${OLD} and ${min(D.next.wall.p50)} on ${NEW}.`;

const fanout = [
  `At p75, ${NEW} starts the first of 64 branches in ${ms(P.next.first.p75)} against ${ms(P.v4.first.p75)} on ${OLD}, then starts the slowest branch at ${ms(P.next.last.p75)} against ${ms(P.v4.last.p75)} and joins in ${ms(P.next.join.p75)} against ${ms(P.v4.join.p75)}.`,
  showP99('fanoutLast') && isSlower(p99.fanoutLast.v4, p99.fanoutLast.next)
    ? `At p99, the slowest branch starts later on ${NEW}: ${ms(p99.fanoutLast.next)} against ${ms(p99.fanoutLast.v4)} on ${OLD}, a gap that reproduced in a second sweep.`
    : '',
]
  .filter(Boolean)
  .join(' ');

const resume = `At p75, a workflow waiting on a hook resumes in ${ms(R.next.ttr.p75)} on ${NEW} against ${ms(R.v4.ttr.p75)} on ${OLD}${
  showP99('ttr')
    ? `, and in ${ms(p99.ttr.next)} against ${ms(p99.ttr.v4)} at p99`
    : ''
}.`;

const streams = [
  `The agent produced its ${count(recording.chunks)}-chunk response over ${sec(recording.ms)}. On ${OLD} the writer step manages about ${Math.round(S.v4.writerChunksPerSec)} chunks per second, so the response takes ${sec(S.v4.wall.p50)} to reach the reader. ${NEW} writes streams over a WebSocket by default, keeps up at about ${Math.round(S.next.writerChunksPerSec)} chunks per second, and delivers the response in ${sec(S.next.wall.p50)}.`,
  `At p75, a chunk reaches the reader in ${ms(S.next.ctt.p75)} on ${NEW} against ${ms(S.v4.ctt.p75)} on ${OLD}. ${NEW} had a chunk delayed by over 1 s in ${S.next.stalledRuns} of ${S.next.runs} runs, against ${S.v4.stalledRuns} of ${S.v4.runs} on ${OLD}.`,
].join('\n\n');

// --- Results table --------------------------------------------------------------------

type Format = (n: number) => string;
const row = (
  label: string,
  a: number,
  b: number,
  n: string,
  fmt: Format = ms
) => `| ${label} | ${fmt(a)} | ${fmt(b)} | ${change(a, b)} | ${n} |`;
const p99Row = (key: P99Key, label: string, n: string) =>
  showP99(key) ? [row(label, p99[key].v4, p99[key].next, n)] : [];
const group = (title: string, rows: string[]) => [
  `| **${title}** | | | | |`,
  ...rows,
];

const table = [
  `| Metric | ${OLD} | ${NEW} | Change | Samples per version |`,
  '| --- | --: | --: | --: | --: |',
  ...group(`Sequential workflow, 5 steps, ${T.next.runs} runs`, [
    row(
      'Time to first step, p75',
      T.v4.ttfs.p75,
      T.next.ttfs.p75,
      samples(T.v4.ttfs.n, T.next.ttfs.n, 'runs')
    ),
    ...p99Row(
      'ttfs',
      'Time to first step, slowest run',
      samples(T.v4.ttfs.n, T.next.ttfs.n, 'runs')
    ),
    row(
      'Step-to-step overhead, p75',
      T.v4.stso.p75,
      T.next.stso.p75,
      samples(T.v4.stso.n, T.next.stso.n, 'gaps')
    ),
    ...p99Row(
      'stso',
      'Step-to-step overhead, p99',
      samples(T.v4.stso.n, T.next.stso.n, 'gaps')
    ),
  ]),
  ...group(
    `Long run, 1,020 steps, ${samples(D.v4.runs, D.next.runs, 'runs')}`,
    [
      row(
        'Step overhead, steps 1 to 20, p75',
        D.v4.early.p75,
        D.next.early.p75,
        samples(D.v4.early.n, D.next.early.n, 'gaps')
      ),
      ...p99Row(
        'deepEarly',
        'Step overhead, steps 1 to 20, p99',
        samples(D.v4.early.n, D.next.early.n, 'gaps')
      ),
      row(
        'Step overhead, steps 101 to 120, p75',
        D.v4.mid.p75,
        D.next.mid.p75,
        samples(D.v4.mid.n, D.next.mid.n, 'gaps')
      ),
      row(
        'Step overhead, steps 1,001 to 1,020, p75',
        D.v4.late.p75,
        D.next.late.p75,
        samples(D.v4.late.n, D.next.late.n, 'gaps')
      ),
      ...p99Row(
        'deepLate',
        'Step overhead, steps 1,001 to 1,020, p99',
        samples(D.v4.late.n, D.next.late.n, 'gaps')
      ),
      row(
        'Whole run, median wall time',
        D.v4.wall.p50,
        D.next.wall.p50,
        samples(D.v4.runs, D.next.runs, 'runs'),
        min
      ),
    ]
  ),
  ...group(`Fan-out, 64 parallel branches, ${P.next.runs} runs`, [
    row(
      'First branch starts, p75',
      P.v4.first.p75,
      P.next.first.p75,
      samples(P.v4.first.n, P.next.first.n, 'runs')
    ),
    ...p99Row(
      'fanoutFirst',
      'First branch starts, p99',
      samples(P.v4.first.n, P.next.first.n, 'runs')
    ),
    row(
      'Slowest branch to start, p75',
      P.v4.last.p75,
      P.next.last.p75,
      samples(P.v4.last.n, P.next.last.n, 'runs')
    ),
    ...p99Row(
      'fanoutLast',
      'Slowest branch to start, p99',
      samples(P.v4.last.n, P.next.last.n, 'runs')
    ),
    row(
      'Join, p75',
      P.v4.join.p75,
      P.next.join.p75,
      samples(P.v4.join.n, P.next.join.n, 'runs')
    ),
    ...p99Row(
      'fanoutJoin',
      'Join, p99',
      samples(P.v4.join.n, P.next.join.n, 'runs')
    ),
  ]),
  ...group(`Resume after 1 s idle, ${R.next.runs} runs of 5 resumes`, [
    row(
      'Time to resume, p50',
      R.v4.ttr.p50,
      R.next.ttr.p50,
      samples(R.v4.ttr.n, R.next.ttr.n, 'resumes')
    ),
    row(
      'Time to resume, p75',
      R.v4.ttr.p75,
      R.next.ttr.p75,
      samples(R.v4.ttr.n, R.next.ttr.n, 'resumes')
    ),
    ...p99Row(
      'ttr',
      'Time to resume, p99',
      samples(R.v4.ttr.n, R.next.ttr.n, 'resumes')
    ),
  ]),
  ...group(
    `Agent stream, ${sec(recording.ms)} recording, ${samples(S.v4.runs, S.next.runs, 'runs')}`,
    [
      row(
        'Delivery, median wall time',
        S.v4.wall.p50,
        S.next.wall.p50,
        samples(S.v4.runs, S.next.runs, 'runs'),
        sec
      ),
      row(
        'Chunk trip time, p75',
        S.v4.ctt.p75,
        S.next.ctt.p75,
        samples(S.v4.ctt.n, S.next.ctt.n, 'chunks')
      ),
      ...p99Row(
        'ctt',
        'Chunk trip time, p99',
        samples(S.v4.ctt.n, S.next.ctt.n, 'chunks')
      ),
    ]
  ),
].join('\n');

// --- Methodology ----------------------------------------------------------------------

const runsPerVersion = `Each version ran the sequential workflow ${T.next.runs} times, the agent stream ${S.next.runs} times, the fan-out ${P.next.runs} times, the resume benchmark ${R.next.runs} times, and the 1,020-step run ${D.next.runs} times.`;

// --- Latest results ---------------------------------------------------------------------

const latest = `**Latest results:** Workflow SDK ${NEW} compared with ${OLD}, measured ${measuredOn}. We run these benchmarks regularly and publish updated results here.`;

const caveats = [
  'Both versions ran at the same time and shared the platform.',
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

// Point the release figures at the latest results' folder.
after = after.replace(
  /(src(?:Light|Dark)=")\/performance\/v[^/"]+\//g,
  `$1${figuresPath}/`
);

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
