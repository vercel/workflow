import { describe, expect, it } from 'vitest';
import { getRun, resumeHook, start } from 'workflow/api';
import { HookConflictError, HookNotFoundError } from 'workflow/errors';
import {
  type CounterReply,
  chatRoom,
  type RoomMessage,
  roomToken,
} from '../workflows/durable-object-room.js';

// The Durable Object migration guide's core pattern: one run per room, with
// commands through a hook, broadcasts on the run's stream, and the object's
// alarm as a sleep(). See
// docs/content/docs/v5/comparisons/workflow-sdk-vs-cloudflare-durable-objects.mdx.

const IDLE_MS = 60_000;

/** Like `idFromName()`: the first caller starts the room, the rest find it. */
async function openRoom(roomId: string, idleMs = IDLE_MS): Promise<string> {
  try {
    const run = await start(chatRoom, [roomId, idleMs], {
      experimental_hook: {
        token: roomToken(roomId),
        experimental_minRetention: '1 day',
      },
    });
    return run.runId;
  } catch (error) {
    if (!HookConflictError.is(error)) throw error;
    return error.conflictingRunId;
  }
}

async function readChunks<T>(
  stream: ReadableStream<T>,
  n: number
): Promise<T[]> {
  const reader = stream.getReader();
  const out: T[] = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  reader.releaseLock();
  return out;
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const roomId = () => `room-${Math.random().toString(36).slice(2)}`;

describe('Durable Object room as one Workflow run per room', () => {
  it('runs one room per ID, however many callers open it at once', async () => {
    const id = roomId();
    const runIds = await Promise.all(
      Array.from({ length: 10 }, () => openRoom(id))
    );
    expect(new Set(runIds).size).toBe(1);

    // All ten increments reach the one run, in some order, each seeing a
    // distinct count, as calls into one object would.
    const run = getRun(runIds[0]);
    const replies = run.getReadable<CounterReply>({ namespace: 'replies' });
    await Promise.all(
      runIds.map((_, i) =>
        resumeHook(roomToken(id), {
          type: 'increment',
          by: 1,
          requestId: `r${i}`,
        })
      )
    );
    const answers = await readChunks(replies, 10);
    expect(answers.map((a) => a.count).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    await run.cancel();
  }, 60_000);

  it('broadcasts in order and lets a reconnecting client catch up from an index', async () => {
    const id = roomId();
    const run = getRun(await openRoom(id));
    const send = (command: Parameters<typeof resumeHook>[1]) =>
      resumeHook(roomToken(id), command);

    await send({ type: 'join', user: 'ana' });
    await send({ type: 'message', user: 'ana', text: 'one' });
    const seen = await readChunks(run.getReadable<RoomMessage>(), 2);
    expect(seen.map((m) => m.seq)).toEqual([1, 2]);

    // "ana" disconnects; "bo" talks; "ana" reconnects from where she was.
    await send({ type: 'join', user: 'bo' });
    await send({ type: 'message', user: 'bo', text: 'two' });
    const missed = await readChunks(
      run.getReadable<RoomMessage>({ startIndex: seen.length }),
      2
    );
    expect(missed).toEqual([
      { seq: 3, kind: 'joined', user: 'bo' },
      { seq: 4, kind: 'message', user: 'bo', text: 'two' },
    ]);

    // A late joiner reads the whole history.
    expect(await readChunks(run.getReadable<RoomMessage>(), 4)).toEqual([
      { seq: 1, kind: 'joined', user: 'ana' },
      { seq: 2, kind: 'message', user: 'ana', text: 'one' },
      { seq: 3, kind: 'joined', user: 'bo' },
      { seq: 4, kind: 'message', user: 'bo', text: 'two' },
    ]);
    await run.cancel();
  }, 60_000);

  it('closes when the idle alarm fires, and stays closed', async () => {
    const id = roomId();
    const run = getRun(await openRoom(id, 2_000));
    const t0 = Date.now();
    await resumeHook(roomToken(id), { type: 'join', user: 'ana' });
    await readChunks(run.getReadable<RoomMessage>(), 1);
    // Activity at about 1s re-arms the alarm: the room closes about 2s
    // after it, not 2s after the start.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await resumeHook(roomToken(id), {
      type: 'message',
      user: 'ana',
      text: 'still here',
    });
    const lastActivity = Date.now();

    expect(await readAll(run.getReadable<RoomMessage>())).toEqual([
      { seq: 1, kind: 'joined', user: 'ana' },
      { seq: 2, kind: 'message', user: 'ana', text: 'still here' },
      { seq: 3, kind: 'closed', reason: 'idle' },
    ]);
    const closedAfter = Date.now() - lastActivity;
    expect(closedAfter).toBeGreaterThanOrEqual(1_500);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_800);
    await expect(run.returnValue).resolves.toEqual({
      roomId: id,
      messages: 3,
      count: 0,
    });

    // Closed for good, like a Durable Object that kept a `closed` flag: no
    // more commands, and the retained token refuses a new room with this ID.
    await expect(
      resumeHook(roomToken(id), { type: 'join', user: 'bo' })
    ).rejects.toSatisfy((error) => HookNotFoundError.is(error));
    await expect(openRoom(id)).resolves.toBe(run.runId);
  }, 60_000);
});
