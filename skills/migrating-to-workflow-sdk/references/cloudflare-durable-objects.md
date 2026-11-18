# Cloudflare Durable Objects -> Workflow SDK

There is no codemod for Durable Objects. An object is a class whose methods the platform calls, and its storage calls, alarm and sockets each become a different part of a run, depending on what the object is for. Decide per object, then apply the templates below. The public guide is `docs/content/docs/v5/comparisons/workflow-sdk-vs-cloudflare-durable-objects.mdx`.

## Decide first

Migrate an object to **one Workflow run per entity** when it:

- waits for things to happen to one entity (chat room, document session, agent conversation, game match, scheduler, delivery);
- keeps state that only it reads between events (sequence numbers, history, status, counters);
- acts on time (idle close, expiry, reminders, retries);
- has clients that tolerate a short delay between sending and seeing the result.

Keep the object, and say so in `## Open Questions`, when it:

- answers hot request/response traffic in the same request (a rate limiter checked on every request, a counter read thousands of times a second);
- serves consistent reads of its state to many callers between writes (publish state from a step to a database instead, or as small `setAttributes()` labels, if you migrate anyway);
- depends on raw WebSocket protocol control (subprotocols, ping/pong, close codes);
- must stay idle at zero cost with many connected clients (a hibernated WebSocket costs nothing; a stream reader holds an HTTP request open).

## Map these constructs

| Durable Objects | Workflow SDK |
| --- | --- |
| `env.X.idFromName(id)` / `env.X.get(id)` | `start(entityWorkflow, [id, ...], { experimental_hook: { token: \`entity:${id}\` } })`; on `HookConflictError` use `error.conflictingRunId` (fall back to `getHookByToken(token).runId` when it is undefined). Check `getHookByToken()` first to skip the start attempt |
| RPC method / `fetch()` into the object | `resumeHook(token, command)` from a route; the run reads commands from its start Hook (`createHook({ token })` with the same token) |
| RPC return value | the run writes `{ requestId, ... }` to a stream namespace (`getWritable({ namespace: 'replies' })` in a step); the route reads `getTailIndex()` before sending, then reads from `tail + 1` until its `requestId` |
| `webSocketMessage(ws, msg)` | `POST` route -> `resumeHook(token, msg)` |
| `ws.send()` / broadcast to `getWebSockets()` | write one chunk per message to `getWritable()` in a step; every reader sees every chunk in order |
| reconnect + catch up from storage history | `run.getReadable({ startIndex })`; with one chunk per message, `startIndex` = last seq seen |
| `storage.get/put/sql` | local variables in the workflow function (replay restores them); a database written from a step for data others must read |
| `storage.setAlarm()` / `alarm()` | one `sleep()` at a time raced against the next command (see template) |
| `blockConcurrencyWhile()` | nothing: commands are read one at a time |
| eviction / restart | nothing: the run resumes from its event log |
| `closed` flag + `deleteAll()` | the run returns; retain the start token (`experimental_minRetention`) so the ID does not start again |

## Templates

Entity run:

```ts
import { createHook, getWritable, sleep } from 'workflow';

export async function chatRoom(roomId: string, idleMs: number) {
  'use workflow';
  const inbox = createHook<RoomCommand>({ token: `room:${roomId}` }); // the start Hook
  const commands = inbox[Symbol.asyncIterator]();
  let seq = 0;
  let next = commands.next();
  let lastActivity = Date.now();
  let alarm = sleep(idleMs).then(() => 'alarm' as const);
  for (;;) {
    const result = await Promise.race([next, alarm]);
    if (result === 'alarm') {
      const idleFor = Date.now() - lastActivity;
      if (idleFor < idleMs) {
        alarm = sleep(idleMs - idleFor).then(() => 'alarm' as const);
        continue;
      }
      await broadcast({ seq: ++seq, kind: 'closed' });
      await closeStream();
      return { roomId, messages: seq };
    }
    if (result.done) break;
    next = commands.next();
    lastActivity = Date.now();
    await broadcast({ seq: ++seq, kind: 'message', ...result.value });
  }
}

async function broadcast(message: RoomMessage) {
  'use step';
  const writer = getWritable<RoomMessage>().getWriter();
  await writer.write(message);
  writer.releaseLock();
}
```

Open an entity (the `idFromName()` step):

```ts
import { getHookByToken, start } from 'workflow/api';
import { HookConflictError } from 'workflow/errors';

export async function openRoom(roomId: string) {
  const token = `room:${roomId}`;
  const existing = await getHookByToken(token).catch(() => null);
  if (existing) return existing.runId;
  try {
    const run = await start(chatRoom, [roomId, IDLE_MS], {
      experimental_hook: { token, experimental_minRetention: '1 day' },
    });
    return run.runId;
  } catch (error) {
    if (!HookConflictError.is(error)) throw error;
    return error.conflictingRunId ?? (await getHookByToken(token)).runId;
  }
}
```

The working version of both, with RPC-style answers and tests, is `workbench/vitest/workflows/durable-object-room.ts` and `workbench/vitest/test/durable-object-room.test.ts`.

## Watch for

- **One timer, not one per command.** `sleep()` cannot be cancelled. A new `sleep()` per loop iteration leaves stale timers that each wake the run later. Re-arm one timer for the remaining idle time, as in the template. `Date.now()` in a workflow is the deterministic replay clock, so the idle check replays the same way.
- **Keep the pending `next()`.** Race the same `commands.next()` promise until it settles; calling `next()` again while one is pending would skip a command.
- **Stream index = sequence.** Write exactly one chunk per message to the main stream, and put anything else (answers, presence) in another namespace, so `startIndex` lines up with the sequence number clients track.
- **Streams in steps only.** `getWritable()` may be called in the workflow, but writing and closing happen in steps.
- **Long-lived entities stay one run.** Start runs with `WORKFLOW_VM=quickjs`: snapshotting keeps resumes fast however many commands the run has handled, and exempts the run from the default [event limit](/docs/errors/max-events-exceeded). Don't add a continue-as-new handoff for size. Start a successor (`deploymentId: 'latest'`, then `createHook({ token, experimental_force: true })` in the successor) only to move an entity onto newer code; keep history other systems read in a database from a step.
- **Retention means closed stays closed.** With `experimental_minRetention`, a finished entity's token refuses a new `start()` and `resumeHook()` throws `HookNotFoundError`; map that to the 410 the object returned when closed. Without retention, the next request starts a fresh entity with the same ID.
- **Cut over by entity.** Existing objects keep running on Cloudflare; start new IDs on the Workflow SDK, or export an object's state and pass it to `start()`.

<!-- Validated on 2026-11-16 against a Durable Object chat room on wrangler 4.163.0 (local) and the run above on the Local World: ordered broadcast to two clients, reconnect catch-up from a sequence number, late-joiner history, concurrent RPC-style increments, ten concurrent first requests reaching one entity, independent entities, and the idle alarm re-arming and closing the room. -->
