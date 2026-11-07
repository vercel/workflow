import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { waitForHook } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { getRun, resumeHook, start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import {
  longMessage,
  type Msg,
  stateRefsAcrossRuns,
  stateRefsBodyProduce,
  stateRefsChat,
  stateRefsClassInState,
  stateRefsFanOut,
  stateRefsLongChain,
  stateRefsOverwrites,
  stateRefsRichValues,
  stateRefsShapes,
} from '../workflows/state-refs.js';

/**
 * Frozen state stored by reference, end to end on the local World
 * (real VM, real queue). Each run is checked for its result and for how its
 * state was stored. QuickJS doesn't write references yet, so there every
 * payload must be stored whole, with the same results.
 */
const refs = process.env.WORKFLOW_VM !== 'quickjs';

type Stored = { type: string; bytes: number; text: string };

/** The payload's text after its format prefix, decompressed (the local World stores it unencrypted). */
function decode(bytes: Uint8Array): string {
  let b = bytes;
  for (;;) {
    const prefix = new TextDecoder().decode(b.subarray(0, 4));
    if (prefix === 'zstd') b = zstdDecompressSync(b.subarray(4));
    else if (prefix === 'gzip') b = gunzipSync(b.subarray(4));
    else return new TextDecoder().decode(b);
  }
}

async function stored(runId: string): Promise<Stored[]> {
  const world = await getWorld();
  const out: Stored[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.events.list({
      runId,
      resolveData: 'all',
      pagination: { cursor, limit: 1000 },
    });
    for (const e of page.data as any[]) {
      const data =
        e.eventData?.input ?? e.eventData?.result ?? e.eventData?.payload;
      const bytes = data instanceof Uint8Array ? data : undefined;
      out.push({
        type: e.eventType,
        bytes: bytes?.byteLength ?? 0,
        text: bytes ? decode(bytes) : '',
      });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

const kinds = (s: Stored) =>
  [...s.text.matchAll(/"(ref|patch|full)"/g)].map((m) => m[1]);
const inputs = (log: Stored[]) => log.filter((e) => e.type === 'step_created');
const outputs = (log: Stored[]) =>
  log.filter((e) => e.type === 'step_completed');

/** With references on, state inputs are refs and outputs patches; off, nothing is a record. */
function expectStorage(log: Stored[], { patches = true } = {}) {
  if (!refs) {
    for (const e of log) expect(e.text).not.toContain('StateRefV1');
    return;
  }
  const stateInputs = inputs(log).filter((e) => kinds(e).length > 0);
  expect(stateInputs.length).toBeGreaterThan(0);
  for (const e of stateInputs) expect(kinds(e)).not.toContain('patch');
  expect(stateInputs.some((e) => kinds(e).includes('ref'))).toBe(true);
  if (patches)
    expect(outputs(log).some((e) => kinds(e).includes('patch'))).toBe(true);
}

describe(`frozen state stored by reference (${refs ? 'node' : 'quickjs: stored whole'})`, () => {
  it('a hook-driven chat, with a retry in a new invocation and a replay', async () => {
    const token = `state-refs-chat-${Math.random().toString(36).slice(2)}`;
    const turns = 6;
    const run = await start(stateRefsChat, [token, turns]);
    // One hook takes every turn; its payloads queue and are read in order.
    await waitForHook(run, { token });
    for (let i = 0; i < turns; i++)
      await resumeHook(token, { text: longMessage(i) });
    const expected: Msg[] = [];
    for (let i = 0; i < turns; i++) {
      expected.push({ role: 'user', content: longMessage(i) });
      if (i !== 2)
        expected.push({
          role: 'assistant',
          content: `reply to ${longMessage(i).slice(0, 8)}`,
        });
    }
    await expect(run.returnValue).resolves.toEqual({
      turns,
      history: expected,
    });

    const log = await stored(run.runId);
    expectStorage(log);
    if (refs) {
      // Long hook strings are stored once, in the hook payload.
      expect(outputs(log).some((e) => e.text.includes('StateSrcV1'))).toBe(
        true
      );
      // Inputs don't grow with the history.
      const sizes = inputs(log)
        .slice(1)
        .map((e) => e.bytes);
      expect(Math.max(...sizes)).toBeLessThan(1500);
    }
  }, 90_000);

  it('a fan-out wider than the inline limit (queued steps rebuild cold)', async () => {
    const run = await start(stateRefsFanOut, [5, 8]);
    await expect(run.returnValue).resolves.toEqual(
      Array.from({ length: 8 }, (_, i) => `${i}:5:10:reply to`)
    );
    expectStorage(await stored(run.runId));
  }, 60_000);

  it('a retry after a long chain rebuilds every version cold', async () => {
    const run = await start(stateRefsLongChain, [40]);
    await expect(run.returnValue).resolves.toEqual({ turns: 41, length: 81 });
    const log = await stored(run.runId);
    expectStorage(log);
    if (refs) {
      const sizes = inputs(log)
        .slice(1)
        .map((e) => e.bytes);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(64);
    }
  }, 90_000);

  it('dates, bytes, null-prototype dictionaries, holes, key order, bigint, -0 and NaN', async () => {
    const run = await start(stateRefsRichValues, []);
    const expected = {
      at: '2026-01-04T00:00:00.000Z',
      bytes: [1, 2, 3, 0, 1, 2],
      dictKeys: ['turn:1', 'turn:2', 'turn:3'],
      dictProto: true,
      holes: [true, false, true, false, true, false, true],
      order: ['a', 'b', 'c'],
      big: '4',
      negZero: true,
      nan: true,
      // Values rebuilt from records arrive deep-frozen; QuickJS stores state
      // whole, so its steps get ordinary mutable copies. (Review on #5215:
      // step input mutability differs between the VMs.)
      frozen: refs,
    };
    await expect(run.returnValue).resolves.toEqual(
      [0, 1, 2, 3, 4].map((i) => ({ i, ...expected }))
    );
    expectStorage(await stored(run.runId), { patches: false });
  }, 60_000);

  it('root replacements, unchanged returns, shared references and rebuilt copies', async () => {
    const run = await start(stateRefsShapes, []);
    await expect(run.returnValue).resolves.toEqual({
      beforeClear: '0:3:4:reply to',
      after: [1, 2, 3, 4].map((i) => `${i}:1:2:reply to`),
      sharedLength: 4,
      final: {
        history: [
          { role: 'user', content: 'three' },
          { role: 'assistant', content: 'reply to three' },
        ],
        turns: 1,
      },
    });
    expectStorage(await stored(run.runId));
  }, 60_000);

  it('large overwrites write the value whole now and then, and still rebuild cold', async () => {
    const rounds = 14;
    const run = await start(stateRefsOverwrites, [rounds]);
    await expect(run.returnValue).resolves.toEqual({
      head: '333',
      size: 30_000,
      log: Array.from({ length: rounds }, (_, i) => `w${i}`),
    });
    const log = await stored(run.runId);
    expectStorage(log);
    if (refs) {
      const outs = outputs(log).slice(1).flatMap(kinds);
      expect(outs).toContain('full');
      expect(outs).toContain('patch');
    }
  }, 90_000);

  it('produce() in the workflow body, passed to queued steps', async () => {
    const run = await start(stateRefsBodyProduce, []);
    await expect(run.returnValue).resolves.toEqual(
      [0, 1, 2, 3, 4].map((i) => `${i}:1:3:from the`)
    );
  }, 60_000);

  it('state passed to another run and returned from this one is stored whole', async () => {
    const run = await start(stateRefsAcrossRuns, []);
    const value = await run.returnValue;
    expect(value.chat.turns).toBe(3);
    await expect(getRun(value.childRunId).returnValue).resolves.toBe(
      '99:3:6:reply to'
    );
    // The child's run input holds the value as a plain value: it can't refer
    // to this run's log, and any reader can read it.
    const world = await getWorld();
    const childRun = await world.runs.get(value.childRunId, {
      resolveData: 'all',
    });
    const input = decode(childRun.input as Uint8Array);
    expect(input).not.toContain('StateRefV1');
  }, 60_000);

  // The engine is chosen per run (`start()` stamps the client's WORKFLOW_VM
  // into the run), while a step's process may run without it. A Node VM
  // workflow marks its step inputs, so a step of a QuickJS run writes no
  // records its workflow can't read.
  // Only meaningful where steps run without WORKFLOW_VM (the node leg).
  (refs ? it : it.skip)(
    'a run started on QuickJS while steps run without WORKFLOW_VM',
    async () => {
      const previous = process.env.WORKFLOW_VM;
      process.env.WORKFLOW_VM = 'quickjs';
      let run: Awaited<ReturnType<typeof start>>;
      try {
        run = await start(stateRefsFanOut, [3, 2]);
      } finally {
        if (previous === undefined) delete process.env.WORKFLOW_VM;
        else process.env.WORKFLOW_VM = previous;
      }
      await expect(run.returnValue).resolves.toEqual([
        '0:3:6:reply to',
        '1:3:6:reply to',
      ]);
    },
    60_000
  );

  // A custom-serde class inside state makes the value not plain data, so it
  // is stored without references and queued steps read it as usual (this
  // failed when state was tracked by lineage: cold steps couldn't revive it).
  it('a custom-serde class inside state, read by queued steps', async () => {
    const run = await start(stateRefsClassInState, []);
    await expect(run.returnValue).resolves.toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `${i}:true:1`)
    );
  }, 60_000);
});
