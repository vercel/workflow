/**
 * Workflows for `test/state-refs.test.ts`: `workflow/state` values stored by
 * reference, through the paths that rebuild them (inline steps, queued steps
 * past the inline limit, retries in a new invocation, replays after a sleep).
 */
import { createHook, getStepMetadata, sleep } from 'workflow';
import { start } from 'workflow/api';
import { type Immutable, produce } from 'workflow/state';

export type Msg = { role: 'user' | 'assistant'; content: string };
export type Chat = { history: Msg[]; turns: number };

/** A user message long enough (≥128 chars) to be stored as a hook reference. */
export const longMessage = (i: number) =>
  `Turn ${i}: please summarise the attached quarterly report and list the three biggest risks you can find in it. `.repeat(
    2
  );

async function reply(chat: Immutable<Chat>, text: string) {
  'use step';
  return produce(chat, (d) => {
    d.history.push(
      { role: 'user', content: text },
      { role: 'assistant', content: `reply to ${text.slice(0, 8)}` }
    );
    d.turns++;
  });
}

async function replyFailingOnce(chat: Immutable<Chat>, text: string) {
  'use step';
  // The first attempt fails, so the retry runs in a new invocation and has
  // to rebuild its input from the run's log.
  if (getStepMetadata().attempt < 2) throw new Error('transient');
  return produce(chat, (d) => {
    d.history.push({ role: 'user', content: text });
    d.turns++;
  });
}

async function summarize(chat: Immutable<Chat>, i: number) {
  'use step';
  return `${i}:${chat.turns}:${chat.history.length}:${chat.history.at(-1)?.content.slice(0, 8)}`;
}

/** A chat driven by a hook, with a retried step and a replay in between. */
export async function stateRefsChat(token: string, turns: number) {
  'use workflow';
  let chat: Immutable<Chat> = { history: [], turns: 0 };
  using hook = createHook<{ text: string }>({ token });
  let i = 0;
  for await (const { text } of hook) {
    chat =
      i === 2 ? await replyFailingOnce(chat, text) : await reply(chat, text);
    if (i === 3) await sleep('1s'); // the next turn replays from the log
    if (++i === turns) break;
  }
  return { turns: chat.turns, history: chat.history };
}

/** One value read by more steps than run inline, so some run queued (cold). */
export async function stateRefsFanOut(turns: number, width: number) {
  'use workflow';
  let chat: Immutable<Chat> = { history: [], turns: 0 };
  for (let i = 0; i < turns; i++) chat = await reply(chat, longMessage(i));
  return Promise.all(
    Array.from({ length: width }, (_, i) => summarize(chat, i))
  );
}

/** Many turns, then a retry that rebuilds the whole chain cold. */
export async function stateRefsLongChain(turns: number) {
  'use workflow';
  let chat: Immutable<Chat> = { history: [], turns: 0 };
  for (let i = 0; i < turns; i++) chat = await reply(chat, `m${i}`);
  chat = await replyFailingOnce(chat, 'last');
  return { turns: chat.turns, length: chat.history.length };
}

type Rich = {
  at: Date;
  bytes: Uint8Array;
  dict: Record<string, { n: number }>;
  sparse: (number | undefined)[];
  order: Record<string, number>;
  big: bigint;
  nums: number[];
};

async function richStart() {
  'use step';
  const dict = Object.create(null) as Record<string, { n: number }>;
  dict['turn:1'] = { n: 1 };
  return produce(
    {
      at: new Date('2026-01-01T00:00:00Z'),
      bytes: new Uint8Array([1, 2, 3]),
      dict,
      sparse: [1] as (number | undefined)[],
      order: { a: 1, b: 2, c: 3 } as Record<string, number>,
      big: 1n,
      nums: [0],
    } as Rich,
    () => {}
  );
}

async function richEdit(s: Immutable<Rich>, round: number) {
  'use step';
  if (round === 1 && getStepMetadata().attempt < 2)
    throw new Error('transient');
  return produce(s, (d) => {
    d.at = new Date(d.at.getTime() + 86_400_000);
    d.bytes = new Uint8Array([...d.bytes, round]);
    d.dict[`turn:${round + 1}`] = { n: round + 1 };
    d.sparse[round * 2 + 2] = round; // leaves holes
    // Move the first key to the end: the order must survive a replay.
    const [first] = Object.keys(d.order);
    if (first !== undefined) {
      const v = d.order[first] as number;
      delete d.order[first];
      d.order[first] = v;
    }
    d.big += 1n;
    d.nums.push(-0, Number.NaN);
  });
}

async function describeRich(s: Immutable<Rich>, i: number) {
  'use step';
  return {
    i,
    at: s.at.toISOString(),
    bytes: [...s.bytes],
    dictKeys: Object.keys(s.dict),
    dictProto: Object.getPrototypeOf(s.dict) === null,
    holes: Array.from({ length: s.sparse.length }, (_, k) => k in s.sparse),
    order: Object.keys(s.order),
    big: s.big.toString(),
    negZero: Object.is(s.nums[1], -0),
    nan: Number.isNaN(s.nums[2]),
    frozen: Object.isFrozen(s) && Object.isFrozen(s.dict),
  };
}

/** Dates, bytes, null-prototype dictionaries, holes, key order, bigint, -0 and NaN. */
export async function stateRefsRichValues() {
  'use workflow';
  let s = await richStart();
  for (let round = 0; round < 3; round++) s = await richEdit(s, round);
  await sleep('1s');
  return Promise.all([0, 1, 2, 3, 4].map((i) => describeRich(s, i)));
}

async function clear(chat: Immutable<Chat>) {
  'use step';
  return produce(chat, () => ({ history: [], turns: 0 }));
}

async function same(chat: Immutable<Chat>) {
  'use step';
  return chat;
}

async function split(chat: Immutable<Chat>) {
  'use step';
  return { whole: chat, history: chat.history };
}

async function rebuilt(chat: Immutable<Chat>) {
  'use step';
  // Returns equal copies: only the real change is a change.
  return produce(chat, () => ({
    history: chat.history.map((m) => ({ ...m })),
    turns: chat.turns + 1,
  }));
}

/** Root replacements, unchanged returns, shared references and rebuilt copies. */
export async function stateRefsShapes() {
  'use workflow';
  let chat: Immutable<Chat> = { history: [], turns: 0 };
  chat = await reply(chat, 'one');
  chat = await reply(chat, 'two');
  chat = await same(chat);
  const parts = await split(chat);
  chat = await rebuilt(parts.whole);
  await sleep('1s');
  const beforeClear = await summarize(chat, 0);
  chat = await clear(chat);
  chat = await reply(chat, 'three');
  const after = await Promise.all([1, 2, 3, 4].map((i) => summarize(chat, i)));
  return {
    beforeClear,
    after,
    sharedLength: parts.history.length,
    final: chat,
  };
}

async function overwrite(
  s: Immutable<{ blob: string; log: string[] }>,
  i: number
) {
  'use step';
  if (i === 9 && getStepMetadata().attempt < 2) throw new Error('transient');
  return produce(s, (d) => {
    d.blob = String(i % 10).repeat(30_000);
    d.log.push(`w${i}`);
  });
}

/** Large overwrites: the snapshot rule writes the value whole from time to time. */
export async function stateRefsOverwrites(rounds: number) {
  'use workflow';
  let s: Immutable<{ blob: string; log: string[] }> = { blob: '', log: [] };
  for (let i = 0; i < rounds; i++) s = await overwrite(s, i);
  return { head: s.blob.slice(0, 3), size: s.blob.length, log: s.log };
}

/** `produce()` in the workflow body, passed to more steps than run inline. */
export async function stateRefsBodyProduce() {
  'use workflow';
  let chat: Immutable<Chat> = await reply({ history: [], turns: 0 }, 'seed');
  chat = produce(chat, (d) => {
    d.history.push({ role: 'user', content: 'from the workflow' });
  });
  chat = await same(chat);
  return Promise.all([0, 1, 2, 3, 4].map((i) => summarize(chat, i)));
}

export async function stateRefsChild(chat: Immutable<Chat>) {
  'use workflow';
  return summarize(chat, 99);
}

async function startChild(chat: Immutable<Chat>) {
  'use step';
  const run = await start(stateRefsChild, [chat]);
  return run.runId;
}

/** State passed to another run, and returned from this one. */
export async function stateRefsAcrossRuns() {
  'use workflow';
  let chat: Immutable<Chat> = { history: [], turns: 0 };
  for (let i = 0; i < 3; i++) chat = await reply(chat, `x${i}`);
  const childRunId = await startChild(chat);
  return { childRunId, chat };
}

export class Point {
  constructor(
    public x: number,
    public y: number
  ) {}
  static [Symbol.for('workflow-serialize')](p: Point) {
    return { x: p.x, y: p.y };
  }
  static [Symbol.for('workflow-deserialize')](d: { x: number; y: number }) {
    return new Point(d.x, d.y);
  }
}

async function withPoint(chat: Immutable<Chat>) {
  'use step';
  return produce(chat, (d) => {
    (d as unknown as { at: Point }).at = new Point(1, 2);
    d.turns++;
  });
}

async function readPoint(chat: Immutable<Chat>, i: number) {
  'use step';
  const at = (chat as unknown as { at: unknown }).at;
  return `${i}:${at instanceof Point}:${(at as Point).x}`;
}

/** A custom-serde class inside state, read by queued (cold) steps. */
export async function stateRefsClassInState() {
  'use workflow';
  let chat: Immutable<Chat> = { history: [], turns: 0 };
  chat = await reply(chat, 'a');
  chat = await withPoint(chat);
  return Promise.all([0, 1, 2, 3, 4, 5].map((i) => readPoint(chat, i)));
}
