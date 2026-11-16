import { createHook, getWritable, sleep } from 'workflow';

// A Cloudflare Durable Object chat room as one Workflow run per room, the
// pattern from docs/content/docs/v5/comparisons/workflow-sdk-vs-cloudflare-durable-objects.mdx:
// - the room ID is the run's start token, so there is one run per room;
// - commands (what the object's webSocketMessage() or RPC methods received)
//   arrive through resumeHook() and are read by a hook loop;
// - broadcasts go to the run's stream, which clients read and resume from
//   an index after a reconnect;
// - the object's alarm becomes one sleep() at a time, raced against the next
//   command.

export type RoomCommand =
  | { type: 'join'; user: string }
  | { type: 'message'; user: string; text: string }
  | { type: 'increment'; by: number; requestId: string };

export type RoomMessage =
  | { seq: number; kind: 'joined'; user: string }
  | { seq: number; kind: 'message'; user: string; text: string }
  | { seq: number; kind: 'closed'; reason: 'idle' };

export type CounterReply = { requestId: string; count: number };

export const roomToken = (roomId: string) => `room:${roomId}`;

export async function chatRoom(roomId: string, idleMs: number) {
  'use workflow';

  // The start Hook: `start()` created it with the same token.
  const inbox = createHook<RoomCommand>({ token: roomToken(roomId) });
  const commands = inbox[Symbol.asyncIterator]();

  let seq = 0;
  let count = 0;
  let next = commands.next();
  // One timer at a time, like a Durable Object's single alarm. A sleep()
  // cannot be cancelled, so instead of a new timer per command, a timer that
  // fires early re-arms for the rest of the idle time.
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
      await broadcast({ seq: ++seq, kind: 'closed', reason: 'idle' });
      await closeStreams();
      return { roomId, messages: seq, count };
    }
    if (result.done) break;
    next = commands.next();
    lastActivity = Date.now();

    const command = result.value;
    if (command.type === 'join') {
      await broadcast({ seq: ++seq, kind: 'joined', user: command.user });
    } else if (command.type === 'message') {
      await broadcast({
        seq: ++seq,
        kind: 'message',
        user: command.user,
        text: command.text,
      });
    } else {
      count += command.by;
      await reply({ requestId: command.requestId, count });
    }
  }
  return { roomId, messages: seq, count };
}

/** One chunk per message, so a message's stream index is `seq - 1`. */
async function broadcast(message: RoomMessage) {
  'use step';
  const writer = getWritable<RoomMessage>().getWriter();
  await writer.write(message);
  writer.releaseLock();
}

/** Answers to RPC-style requests, on their own stream. */
async function reply(answer: CounterReply) {
  'use step';
  const writer = getWritable<CounterReply>({
    namespace: 'replies',
  }).getWriter();
  await writer.write(answer);
  writer.releaseLock();
}

async function closeStreams() {
  'use step';
  await getWritable<RoomMessage>().close();
  await getWritable<CounterReply>({ namespace: 'replies' }).close();
}
