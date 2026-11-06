/**
 * Property-based fuzzing of `workflow/state` storage by reference.
 *
 * Each case simulates one run against an in-memory log: a run input, hook
 * payloads, steps called with state (inline in the replay's context, or cold
 * through the real `recoverStateContext`), parallel fan-outs, retries, new
 * invocations that replay the log, `produce()` in the workflow body (lineage
 * visible to the serializer, the worst case) and plain immer results. Every
 * value read back, by any reader and at any later time, must equal a plain
 * shadow copy maintained alongside it: same keys in the same order, same
 * holes, same prototypes, same dates and bytes.
 *
 * `FUZZ_RUNS` and `FUZZ_SEED` widen a run locally, e.g.
 * `FUZZ_RUNS=20000 pnpm vitest run src/serialization/state-refs.fuzz.test.ts`.
 */
import { produce as immerProduce } from 'immer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  dehydrateWorkflowReturnValue,
  hydrateStepArguments,
  hydrateStepReturnValue,
  hydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../serialization.js';
import { produce } from '../state.js';
import {
  bindStateContext,
  registerStateSource,
  StateContext,
  stateContextForData,
  stateSourceId,
} from './state-refs.js';

// ---- simulated World ------------------------------------------------------

interface LogEvent {
  eventId: string;
  eventType: 'hook_received' | 'step_created' | 'step_completed';
  eventData: { payload?: unknown; result?: unknown; input?: unknown };
}
const sim = {
  runInput: undefined as unknown,
  events: [] as LogEvent[],
  pageSize: 3,
  failReads: 0,
};
vi.mock('../runtime/get-world-lazy.js', () => ({
  getWorldLazy: async () => ({
    runs: { get: async () => ({ input: copyBytes(sim.runInput) }) },
    events: {
      list: async ({ pagination }: { pagination: { cursor?: string } }) => {
        if (sim.failReads > 0) {
          sim.failReads--;
          throw new Error('simulated World outage');
        }
        // Like a real World: skip-step-inputs drops step inputs, and every
        // payload comes back as fresh bytes (never the writer's object).
        const start = pagination.cursor ? Number(pagination.cursor) : 0;
        const page = sim.events.slice(start, start + sim.pageSize);
        const end = start + page.length;
        return {
          data: page.map((e) => ({
            ...e,
            eventData: {
              payload: copyBytes(e.eventData.payload),
              result: copyBytes(e.eventData.result),
            },
          })),
          hasMore: end < sim.events.length,
          cursor: String(end),
        };
      },
    },
  }),
}));

function copyBytes(v: unknown): unknown {
  return v instanceof Uint8Array ? new Uint8Array(v) : v;
}

// ---- seeded randomness ----------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

// ---- strict structural equality (the oracle) -------------------------------

function sameShape(a: unknown, b: unknown, path = '$'): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (typeof a !== typeof b) return `${path}: ${typeof a} vs ${typeof b}`;
  if (a === null || b === null || typeof a !== 'object')
    return `${path}: ${String(a)} vs ${String(b)}`;
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
      ? undefined
      : `${path}: date`;
  if (a instanceof Uint8Array || b instanceof Uint8Array)
    return a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((x, i) => x === b[i])
      ? undefined
      : `${path}: bytes`;
  if (a instanceof Set || b instanceof Set)
    return a instanceof Set &&
      b instanceof Set &&
      sameShape([...a], [...b]) === undefined
      ? undefined
      : `${path}: set`;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b))
    return ArrayBuffer.isView(a) &&
      ArrayBuffer.isView(b) &&
      a.constructor === b.constructor &&
      String([...(a as any)]) === String([...(b as any)])
      ? undefined
      : `${path}: typed array`;
  if (
    a instanceof RegExp ||
    b instanceof RegExp ||
    a instanceof URL ||
    b instanceof URL
  )
    return a?.constructor === b?.constructor && String(a) === String(b)
      ? undefined
      : `${path}: ${String(a)} vs ${String(b)}`;
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size)
      return `${path}: map`;
    const ea = [...a.entries()];
    const eb = [...b.entries()];
    for (let i = 0; i < ea.length; i++) {
      const d =
        sameShape(ea[i]?.[0], eb[i]?.[0], `${path}<k${i}>`) ??
        sameShape(ea[i]?.[1], eb[i]?.[1], `${path}<v${i}>`);
      if (d) return d;
    }
    return undefined;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      if (i in a !== i in b) return `${path}[${i}]: hole mismatch`;
      const d = sameShape(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b))
    return `${path}: prototype`;
  const ka = Object.keys(a);
  const kb = Object.keys(b as object);
  if (ka.join('\u0000') !== kb.join('\u0000'))
    return `${path}: keys [${ka}] vs [${kb}]`;
  for (const k of ka) {
    const d = sameShape(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      `${path}.${k}`
    );
    if (d) return d;
  }
  return undefined;
}

/** A deep, unfrozen copy that keeps holes, key order and null prototypes. */
function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime()) as T;
  if (v instanceof Uint8Array) return new Uint8Array(v) as T;
  if (v instanceof Map)
    return new Map([...v].map(([k, x]) => [clone(k), clone(x)])) as T;
  if (v instanceof Set) return new Set([...v].map(clone)) as T;
  if (ArrayBuffer.isView(v)) return (v as any).slice() as T;
  if (v instanceof RegExp) return new RegExp(v.source, v.flags) as T;
  if (v instanceof URL) return new URL(v.href) as T;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) if (i in v) out[i] = clone(v[i]);
    return out as T;
  }
  const out: Record<string, unknown> =
    Object.getPrototypeOf(v) === null ? Object.create(null) : {};
  for (const k of Object.keys(v)) out[k] = clone((v as any)[k]);
  return out as T;
}

// ---- random state edits -----------------------------------------------------

type Dict = Record<string, any>;

/** Long strings a hook payload may also hold, so source refs get exercised. */
function longString(r: Rng, pool: string[]): string {
  if (pool.length > 0 && r.chance(0.6)) return r.pick(pool);
  return `message ${r.int(1e6)} `.repeat(10 + r.int(10));
}

const EXTRA_LEAVES = process.env.FUZZ_EXTRA_LEAVES !== '0';

function leaf(r: Rng, pool: string[], depth: number): unknown {
  if (EXTRA_LEAVES && r.chance(0.1))
    return r.pick([
      // Not Map or Set: workflow/state's private immer has no MapSet plugin,
      // so a recipe that reads one throws (review on #5214).
      () => new Float64Array([r.next()]),
      () => new Int32Array([r.int(99)]),
      () => /ab+c/gi,
      () => new URL(`https://example.com/${r.int(9)}`),
    ])();
  switch (r.int(depth > 2 ? 12 : 15)) {
    case 0:
      return r.int(100);
    case 1:
      return r.pick([0, -0, Number.NaN, 1.5, -7]);
    case 2:
      return `s${r.int(50)}`;
    case 3:
      return longString(r, pool);
    case 4:
      return r.chance(0.5);
    case 5:
      return null;
    case 6:
      return undefined;
    case 7:
      return new Date(1_700_000_000_000 + r.int(1e9));
    case 8:
      return new Uint8Array([r.int(256), r.int(256), r.int(256)]);
    case 9:
      return BigInt(r.int(1e6));
    case 10:
      return {
        role: r.pick(['user', 'assistant']),
        content: longString(r, pool),
      };
    case 11:
      return `k${r.int(5)}`;
    case 12:
      return [leaf(r, pool, depth + 1), leaf(r, pool, depth + 1)];
    case 13: {
      const o: Dict = r.chance(0.3) ? Object.create(null) : {};
      for (let i = 0; i < 1 + r.int(3); i++)
        o[`f${r.int(6)}`] = leaf(r, pool, depth + 1);
      return o;
    }
    default:
      return { nested: { deep: leaf(r, pool, depth + 1) } };
  }
}

/** Containers (arrays and plain objects) reachable from `v`, with their paths. */
function containers(
  v: unknown,
  path: (string | number)[] = [],
  out: { path: (string | number)[]; kind: 'array' | 'object' }[] = [],
  depth = 0
) {
  if (depth > 5 || v === null || typeof v !== 'object') return out;
  if (Array.isArray(v)) {
    out.push({ path, kind: 'array' });
    for (let i = 0; i < v.length; i++)
      if (i in v) containers(v[i], [...path, i], out, depth + 1);
  } else if (
    Object.getPrototypeOf(v) === null ||
    Object.getPrototypeOf(v) === Object.prototype
  ) {
    out.push({ path, kind: 'object' });
    for (const k of Object.keys(v))
      containers((v as Dict)[k], [...path, k], out, depth + 1);
  }
  return out;
}
const at = (v: any, path: (string | number)[]) =>
  path.reduce((x, k) => x[k], v);

type Edit = (target: any) => unknown;

/**
 * One random edit, as a function that mutates a draft or a plain copy the same
 * way. Returns `undefined` (edit in place) or a replacement value.
 */
function randomEdit(r: Rng, value: unknown, pool: string[]): Edit {
  const cs = containers(value);
  const c = cs.length > 0 ? r.pick(cs) : undefined;
  const choice = r.int(16);
  if (c === undefined || choice === 0) {
    const replacement = leaf(r, pool, 0);
    // A root is always draftable (a plain object or an array), as in real state.
    const root =
      replacement !== null &&
      typeof replacement === 'object' &&
      (Array.isArray(replacement) ||
        [null, Object.prototype].includes(Object.getPrototypeOf(replacement)))
        ? replacement
        : { items: [replacement] };
    return () => clone(root);
  }
  if (choice === 1) return () => undefined; // no-op recipe
  if (choice === 2) {
    // A recipe returning a rebuilt copy: equal data, new identities, maybe one change.
    const change = r.chance(0.5);
    const k = `r${r.int(4)}`;
    const v2 = leaf(r, pool, 1);
    return (t) => {
      const copy = clone(t);
      if (change && copy && typeof copy === 'object' && !Array.isArray(copy))
        (copy as Dict)[k] = clone(v2);
      return copy;
    };
  }
  if (c.kind === 'array') {
    const items = Array.from({ length: 1 + r.int(3) }, () => leaf(r, pool, 1));
    switch (choice % 7) {
      case 0:
      case 1:
        return (t) => void at(t, c.path).push(...clone(items));
      case 2:
        return (t) => void at(t, c.path).pop();
      case 3:
        return (t) => void at(t, c.path).shift();
      case 4: {
        const i = r.int(4);
        const del = r.int(2);
        return (t) => void at(t, c.path).splice(i, del, ...clone(items));
      }
      case 5: {
        // Index write, sometimes past the end (makes a hole).
        const i = r.int(6);
        return (t) => {
          at(t, c.path)[i] = clone(items[0]);
        };
      }
      default:
        return (t) => {
          at(t, c.path).length = 0; // clear
        };
    }
  }
  const key = r.pick([
    'a',
    'b',
    'c',
    'history',
    'constructor',
    'prototype',
    '1',
    '0',
  ]);
  switch (choice % 5) {
    case 0:
    case 1: {
      const v2 = leaf(r, pool, 1);
      return (t) => {
        at(t, c.path)[key] = clone(v2);
      };
    }
    case 2:
      return (t) => {
        delete at(t, c.path)[key];
      };
    case 3:
      // Re-insert an existing key so it moves to the end (key order change).
      return (t) => {
        const o = at(t, c.path);
        const ks = Object.keys(o);
        if (ks.length === 0) return;
        const k = ks[0] as string;
        const v = o[k];
        delete o[k];
        o[k] = v;
      };
    default: {
      const items = [leaf(r, pool, 1)];
      return (t) => {
        const o = at(t, c.path);
        o.history = Array.isArray(o.history) ? o.history : [];
        o.history.push(...clone(items));
      };
    }
  }
}

/** Applies an edit with workflow/state, plain immer, or to the shadow copy. */
function applyEdit(
  how: 'produce' | 'immer' | 'shadow',
  value: unknown,
  edit: Edit
): unknown {
  if (how === 'shadow') {
    const copy = clone(value);
    const out = edit(copy);
    return out === undefined ? copy : clone(out);
  }
  const recipe = (d: any) => edit(d) as any;
  if (value === null || typeof value !== 'object') {
    const out = edit(value);
    return out === undefined ? value : out;
  }
  return how === 'produce'
    ? produce(value as object, recipe)
    : immerProduce(value as object, recipe);
}

// ---- one simulated run -----------------------------------------------------

interface Held {
  value: unknown;
  shadow: unknown;
}
interface Pending {
  id: string;
  input: Uint8Array;
  shadows: unknown[];
  edit: Edit;
  argIndex: number;
  identity: boolean;
  share: boolean;
}

const RUN_ID = 'wrun_fuzz';
export const semantics = new Map<string, number>();

class Run {
  readonly r: Rng;
  readonly trace: string[] = [];
  pool: string[] = [];
  held: Held[] = [];
  pending: Pending[] = [];
  /** Shadow of every step output, by event index, for later replays. */
  outputShadows = new Map<number, unknown>();
  inputShadows = new Map<number, unknown[]>();
  replay = new StateContext();
  vmGlobal: Record<string, any> = Object.create(globalThis);
  nextEvent = 0;
  readonly opts: { bodyProduce: boolean; coldShare: number };

  constructor(seed: number, opts: { bodyProduce: boolean; coldShare: number }) {
    this.r = rng(seed);
    this.opts = opts;
    sim.events = [];
    sim.runInput = undefined;
    sim.pageSize = 1 + this.r.int(4);
    sim.failReads = 0;
  }

  /** Where `produce()` and the same edit in plain JS disagree (not a storage property). */
  noteSemantics(how: string, got: unknown, plain: unknown) {
    const d = sameShape(got, plain);
    if (d)
      semantics.set(
        `${how}: ${d.replace(/\[\d+\]/g, '[i]')}`,
        (semantics.get(`${how}: ${d.replace(/\[\d+\]/g, '[i]')}`) ?? 0) + 1
      );
  }

  check(what: string, got: unknown, want: unknown) {
    const d = sameShape(got, want);
    if (d)
      throw new Error(
        `${what}: ${d}\n  trace:\n    ${this.trace.slice(-25).join('\n    ')}`
      );
  }

  private eventId() {
    return `evnt_${String(this.nextEvent++).padStart(6, '0')}`;
  }

  async start() {
    const initial: unknown = {
      history: [] as unknown[],
      meta: { title: longString(this.r, this.pool) },
    };
    this.pool.push((initial as Dict).meta.title);
    sim.runInput = await dehydrateWorkflowArguments(
      [initial],
      RUN_ID,
      undefined,
      [],
      globalThis
    );
    await this.newInvocation();
  }

  /** A new invocation: a fresh replay context reads the log in order. */
  async newInvocation() {
    this.trace.push('newInvocation');
    this.replay = new StateContext();
    this.vmGlobal = Object.create(globalThis);
    bindStateContext(this.vmGlobal, this.replay);
    const [arg] = await hydrateWorkflowArguments(
      copyBytes(sim.runInput),
      RUN_ID,
      undefined,
      this.vmGlobal
    );
    registerStateSource(this.vmGlobal, stateSourceId('run-input'), [arg]);
    const held: Held[] = [{ value: arg, shadow: clone(arg) }];
    for (let i = 0; i < sim.events.length; i++) {
      const e = sim.events[i] as LogEvent;
      if (e.eventType === 'hook_received') {
        const payload = await hydrateStepReturnValue(
          copyBytes(e.eventData.payload),
          RUN_ID,
          undefined,
          this.vmGlobal
        );
        registerStateSource(this.vmGlobal, stateSourceId(e), payload);
      } else if (e.eventType === 'step_completed') {
        const out = await hydrateStepReturnValue(
          copyBytes(e.eventData.result),
          RUN_ID,
          undefined,
          this.vmGlobal
        );
        const want = this.outputShadows.get(i);
        this.check(`replay of output #${i}`, out, want);
        held.push({ value: out, shadow: clone(want) });
        if (out && typeof out === 'object' && 'pair' in out)
          held.push({
            value: (out as Dict).pair,
            shadow: clone((want as Dict).pair),
          });
      }
    }
    // Workflow code keeps a few recent values (and can drop old ones).
    this.held = held.slice(-4);
    this.pending = [];
  }

  async hook() {
    const text = longString(this.r, this.pool);
    this.pool.push(text);
    const payload = this.r.chance(0.5)
      ? { text }
      : { parts: [{ type: 'text', text }], note: 'short' };
    const bytes = await dehydrateStepReturnValue(
      payload,
      RUN_ID,
      undefined,
      [],
      globalThis
    );
    const e: LogEvent = {
      eventId: this.eventId(),
      eventType: 'hook_received',
      eventData: { payload: bytes },
    };
    sim.events.push(e);
    this.trace.push(`hook ${e.eventId}`);
    // Replay delivers it in this invocation too.
    const revived = await hydrateStepReturnValue(
      copyBytes(bytes),
      RUN_ID,
      undefined,
      this.vmGlobal
    );
    registerStateSource(this.vmGlobal, stateSourceId(e), revived);
  }

  /** `produce()` (or plain immer) in the workflow body, on a held value. */
  bodyEdit() {
    const h = this.r.pick(this.held);
    const edit = randomEdit(this.r, h.value, this.pool);
    const how =
      this.opts.bodyProduce && this.r.chance(0.7) ? 'produce' : 'immer';
    const value = applyEdit(how, h.value, edit);
    this.noteSemantics(how, value, applyEdit('shadow', h.shadow, edit));
    this.held.push({ value, shadow: clone(value) });
    this.trace.push(`body ${how}`);
  }

  async callStep() {
    const n = 1 + this.r.int(2);
    const args = Array.from({ length: n }, () => this.r.pick(this.held));
    const bytes = (await dehydrateStepArguments(
      { args: args.map((a) => a.value) },
      RUN_ID,
      undefined,
      this.vmGlobal
    )) as Uint8Array;
    const e: LogEvent = {
      eventId: this.eventId(),
      eventType: 'step_created',
      eventData: { input: bytes },
    };
    sim.events.push(e);
    this.inputShadows.set(
      sim.events.length - 1,
      args.map((a) => clone(a.shadow))
    );
    const argIndex = this.r.int(n);
    this.pending.push({
      id: e.eventId,
      input: bytes,
      shadows: args.map((a) => clone(a.shadow)),
      edit: randomEdit(this.r, args[argIndex]?.shadow, this.pool),
      argIndex,
      identity: this.r.chance(0.12),
      share: this.r.chance(0.15),
    });
    this.trace.push(`call ${e.eventId} args=${n}`);
  }

  async runStep() {
    if (this.pending.length === 0) return;
    const i = this.r.int(this.pending.length);
    const p = this.pending.splice(i, 1)[0] as Pending;
    const cold = this.r.chance(this.opts.coldShare);
    if (cold && this.r.chance(0.2)) sim.failReads = 1; // one transient World error
    this.trace.push(`run ${p.id} ${cold ? 'cold' : 'inline'}`);
    let hydrated: any;
    try {
      hydrated = cold
        ? await hydrateStepArguments(copyBytes(p.input), RUN_ID, undefined)
        : await hydrateStepArguments(
            p.input,
            RUN_ID,
            undefined,
            [],
            globalThis,
            {},
            undefined,
            undefined,
            undefined,
            this.replay
          );
    } catch (error) {
      if ((error as Error).name === 'WorkflowStateRecoveryError') {
        // The executor redelivers; the next attempt reads again.
        this.trace.push('  recovery error, redelivered');
        hydrated = await hydrateStepArguments(
          copyBytes(p.input),
          RUN_ID,
          undefined
        );
      } else throw error;
    }
    // An outage that no read hit (nothing needed recovery) does not linger.
    sim.failReads = 0;
    this.check(
      `input of ${p.id} (${cold ? 'cold' : 'inline'})`,
      hydrated.args,
      p.shadows
    );
    const ctx = cold ? stateContextForData(hydrated) : this.replay;
    // The step body.
    const base = hydrated.args[p.argIndex];
    const baseShadow = p.shadows[p.argIndex];
    let value: unknown;
    let shadow: unknown;
    if (p.identity) {
      value = base;
      shadow = clone(baseShadow);
    } else {
      value = applyEdit('produce', base, p.edit);
      this.noteSemantics(
        'produce',
        value,
        applyEdit('shadow', baseShadow, p.edit)
      );
      // #5214 promises immer's behavior: the same edit through immer must agree.
      this.check(
        `produce() vs immer for ${p.id}`,
        value,
        applyEdit('immer', base, p.edit)
      );
      // The property under test: every reader gets what the writer held.
      shadow = clone(value);
    }
    if (p.share && value && typeof value === 'object') {
      // Two references to state in one output, plus another argument's value.
      value = { main: value, pair: hydrated.args[0] };
      shadow = { main: shadow, pair: clone(p.shadows[0]) };
    }
    const out = (await dehydrateStepReturnValue(
      value,
      RUN_ID,
      undefined,
      [],
      globalThis,
      false, // v1Compat
      false, // framedByteStreams
      false, // compression
      undefined, // runReadyBarrier
      undefined, // readbackOps
      false, // framedAbortStreams
      ctx
    )) as Uint8Array;
    const e: LogEvent = {
      eventId: this.eventId(),
      eventType: 'step_completed',
      eventData: { result: out },
    };
    sim.events.push(e);
    this.outputShadows.set(sim.events.length - 1, shadow);
    if (!cold) {
      // The workflow consumes it in this invocation, through the replay context.
      const got = await hydrateStepReturnValue(
        copyBytes(out),
        RUN_ID,
        undefined,
        this.vmGlobal
      );
      this.check(`output of ${p.id} read in the same invocation`, got, shadow);
      this.held.push({ value: got, shadow: clone(shadow) });
      if (p.share)
        this.held.push({
          value: got.pair,
          shadow: clone((shadow as Dict).pair),
        });
      if (this.held.length > 6) this.held.splice(1, 1);
    }
  }

  /** Every stored step input stays readable cold later (a retry, the dashboard). */
  async coldReadAllInputs() {
    for (const [i, shadows] of this.inputShadows) {
      const e = sim.events[i] as LogEvent;
      const got = await hydrateStepArguments(
        copyBytes(e.eventData.input),
        RUN_ID,
        undefined
      );
      this.check(`later cold read of input #${i}`, got.args, shadows);
    }
  }

  async returnValue() {
    const h = this.r.pick(this.held);
    const bytes = await dehydrateWorkflowReturnValue(
      { result: h.value },
      RUN_ID,
      undefined,
      this.vmGlobal
    );
    const got = await hydrateWorkflowReturnValue(bytes, RUN_ID, undefined);
    this.check(
      'workflow return value read without the log',
      got.result,
      h.shadow
    );
  }
}

async function fuzzOne(
  seed: number,
  opts: { bodyProduce: boolean; coldShare: number }
) {
  const run = new Run(seed, opts);
  await run.start();
  const steps = 10 + run.r.int(30);
  for (let s = 0; s < steps; s++) {
    const a = run.r.int(100);
    if (a < 10) await run.hook();
    else if (a < 20) run.bodyEdit();
    else if (a < 50) await run.callStep();
    else if (a < 85) await run.runStep();
    else if (a < 92) {
      while (run.pending.length > 0) await run.runStep();
      await run.newInvocation();
    } else {
      // Fan-out: several steps on one value, run in random order.
      for (let k = 0; k < 2 + run.r.int(3); k++) await run.callStep();
      while (run.pending.length > 0) await run.runStep();
    }
  }
  while (run.pending.length > 0) await run.runStep();
  await run.newInvocation();
  await run.coldReadAllInputs();
  await run.returnValue();
  return sim.events.length;
}

const RUNS = Number(process.env.FUZZ_RUNS ?? 150);
const SEED = Number(process.env.FUZZ_SEED ?? 1);

describe('workflow/state storage by reference: fuzzing', () => {
  afterEach(() => {
    sim.failReads = 0;
  });

  it(`every reader rebuilds what every writer held (${RUNS} runs from seed ${SEED})`, async () => {
    let events = 0;
    for (let i = 0; i < RUNS; i++) {
      const seed = SEED + i;
      try {
        events += await fuzzOne(seed, { bodyProduce: true, coldShare: 0.4 });
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    expect(events).toBeGreaterThan(RUNS * 5);
    if (process.env.FUZZ_REPORT)
      (await import('node:fs')).writeFileSync(
        process.env.FUZZ_REPORT,
        JSON.stringify([...semantics], null, 1)
      );
  }, 600_000);

  it(`all steps cold, as for a fan-out past the inline limit (${Math.ceil(RUNS / 3)} runs)`, async () => {
    for (let i = 0; i < Math.ceil(RUNS / 3); i++) {
      const seed = SEED + 100_000 + i;
      try {
        await fuzzOne(seed, { bodyProduce: false, coldShare: 1 });
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
  }, 600_000);
});
