import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkflowInvokePayload } from '@workflow/world';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from './index.js';
import { createQueue } from './queue';
import {
  getQueueHolder,
  isHolderGone,
  QUEUE_JOURNAL_DIR,
} from './queue-journal';
import { createRun, updateRun } from './test-helpers.js';

// Mock node:timers/promises so the queue's waits resolve immediately.
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const workflowPayload: WorkflowInvokePayload = { runId: 'wrun_01ABC' };

/** Let any delivery still in flight finish what it would do. */
const settle = () =>
  new Promise((resolve) => globalThis.setTimeout(resolve, 50));

/** The pid of a process that has already exited. */
function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  if (!pid) throw new Error('could not spawn a process');
  return pid;
}

describe('isHolderGone', () => {
  it('treats this process as alive', () => {
    expect(isHolderGone(getQueueHolder())).toBe(false);
  });

  it('treats an earlier process with this pid as gone', () => {
    expect(isHolderGone({ ...getQueueHolder(), bootId: 'earlier' })).toBe(true);
  });

  it('treats an exited process as gone', () => {
    expect(
      isHolderGone({ pid: exitedPid(), host: hostname(), bootId: 'exited' })
    ).toBe(true);
  });

  it('treats another live process as alive', () => {
    expect(
      isHolderGone({ pid: process.ppid, host: hostname(), bootId: 'parent' })
    ).toBe(false);
  });

  it('never treats a process on another host as gone', () => {
    expect(
      isHolderGone({ pid: exitedPid(), host: `not-${hostname()}`, bootId: 'x' })
    ).toBe(false);
  });
});

describe('the local queue journal', () => {
  let dataDir: string;
  const queues: ReturnType<typeof createQueue>[] = [];
  const journalDir = () => path.join(dataDir, QUEUE_JOURNAL_DIR);

  function newQueue(overrides: { tag?: string; recover?: boolean } = {}) {
    const queue = createQueue({
      dataDir,
      baseUrl: 'http://localhost:3000',
      recoverActiveRuns: overrides.recover ?? true,
      ...(overrides.tag && { tag: overrides.tag }),
    });
    queues.push(queue);
    return queue;
  }

  async function journalFiles(): Promise<string[]> {
    try {
      return (await readdir(journalDir())).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  async function readEntry(file: string) {
    return JSON.parse(await readFile(path.join(journalDir(), file), 'utf-8'));
  }

  /** A journal entry left by a process that died while delivering it. */
  async function writeOrphan(
    entry: { messageId: string; attempt: number; dueAt: number },
    tag?: string
  ) {
    await mkdir(journalDir(), { recursive: true });
    await writeFile(
      path.join(
        journalDir(),
        tag ? `${entry.messageId}.${tag}.json` : `${entry.messageId}.json`
      ),
      JSON.stringify({
        queueName: '__wkf_workflow_test',
        body: JSON.stringify(workflowPayload),
        holder: { pid: exitedPid(), host: hostname(), bootId: 'dead' },
        ...entry,
      })
    );
  }

  /** A direct handler that records each delivery and holds it until released. */
  function recordingHandler(queue: ReturnType<typeof createQueue>) {
    const seen: { messageId: string; attempt: number }[] = [];
    const held: (() => void)[] = [];
    let hold = false;
    queue.registerHandler(
      '__wkf_workflow_',
      queue.createQueueHandler(
        '__wkf_workflow_',
        async (_message, { messageId, attempt }) => {
          seen.push({ messageId, attempt });
          if (hold) await new Promise<void>((resolve) => held.push(resolve));
        }
      )
    );
    return {
      seen,
      holdDeliveries() {
        hold = true;
      },
      releaseAll() {
        hold = false;
        for (const release of held.splice(0)) release();
      },
    };
  }

  beforeEach(async () => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
    dataDir = await mkdtemp(path.join(tmpdir(), 'wf-queue-journal-'));
  });

  afterEach(async () => {
    await Promise.all(queues.splice(0).map((queue) => queue.close()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('journals a message from queue() until it is acknowledged', async () => {
    const queue = newQueue();
    const handler = recordingHandler(queue);
    handler.holdDeliveries();

    const { messageId } = await queue.queue(
      '__wkf_workflow_test' as any,
      workflowPayload
    );

    expect(await journalFiles()).toEqual([`${messageId}.json`]);
    expect(await readEntry(`${messageId}.json`)).toMatchObject({
      messageId,
      queueName: '__wkf_workflow_test',
      attempt: 1,
      holder: getQueueHolder(),
    });

    await vi.waitFor(() => expect(handler.seen).toHaveLength(1));
    handler.releaseAll();
    await vi.waitFor(async () => expect(await journalFiles()).toEqual([]));
  });

  it('journals a wake as the same message with its next attempt', async () => {
    const queue = newQueue();
    let calls = 0;
    let release!: () => void;
    queue.registerHandler(
      '__wkf_workflow_',
      queue.createQueueHandler('__wkf_workflow_', async () => {
        calls++;
        if (calls === 1) return { timeoutSeconds: 30 };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })
    );

    const before = Date.now();
    const { messageId } = await queue.queue(
      '__wkf_workflow_test' as any,
      workflowPayload
    );

    await vi.waitFor(() => expect(calls).toBe(2));
    const entry = await readEntry(`${messageId}.json`);
    expect(entry.attempt).toBe(2);
    expect(entry.dueAt).toBeGreaterThanOrEqual(before + 30_000);

    release();
    await vi.waitFor(async () => expect(await journalFiles()).toEqual([]));
  });

  it('keeps a message journaled when the queue closes during its delivery', async () => {
    const queue = newQueue();
    const handler = recordingHandler(queue);
    handler.holdDeliveries();

    const { messageId } = await queue.queue(
      '__wkf_workflow_test' as any,
      workflowPayload
    );
    await vi.waitFor(() => expect(handler.seen).toHaveLength(1));

    await queue.close();
    handler.releaseAll();
    // Give the finished delivery its chance to (wrongly) forget the message.
    await settle();

    expect(await journalFiles()).toEqual([`${messageId}.json`]);
  });

  it("redelivers a dead process's message with its own messageId and the next attempt", async () => {
    const messageId = 'msg_01JORPHANDUE0000000000000';
    await writeOrphan({ messageId, attempt: 1, dueAt: Date.now() - 1000 });

    const queue = newQueue();
    const handler = recordingHandler(queue);
    await queue.redeliverOrphans();

    // The dead process may have reached the handler with attempt 1 already.
    await vi.waitFor(() =>
      expect(handler.seen).toEqual([{ messageId, attempt: 2 }])
    );
    await vi.waitFor(async () => expect(await journalFiles()).toEqual([]));
  });

  it('keeps the attempt and the remaining delay of a message that was still waiting', async () => {
    const messageId = 'msg_01JORPHANWAITING000000000';
    await writeOrphan({ messageId, attempt: 3, dueAt: Date.now() + 60_000 });
    const { setTimeout: sleep } = await import('node:timers/promises');
    vi.mocked(sleep).mockClear();

    const queue = newQueue();
    const handler = recordingHandler(queue);
    await queue.redeliverOrphans();

    await vi.waitFor(() =>
      expect(handler.seen).toEqual([{ messageId, attempt: 3 }])
    );
    const [delayMs] = vi.mocked(sleep).mock.calls[0] as [number];
    expect(delayMs).toBeGreaterThan(55_000);
    expect(delayMs).toBeLessThanOrEqual(60_000);
  });

  it("leaves a live process's messages alone", async () => {
    const messageId = 'msg_01JLIVEHOLDER0000000000000';
    await mkdir(journalDir(), { recursive: true });
    await writeFile(
      path.join(journalDir(), `${messageId}.json`),
      JSON.stringify({
        messageId,
        queueName: '__wkf_workflow_test',
        body: JSON.stringify(workflowPayload),
        attempt: 1,
        dueAt: Date.now(),
        holder: getQueueHolder(),
      })
    );

    const queue = newQueue();
    const handler = recordingHandler(queue);
    await queue.redeliverOrphans();
    await settle();

    expect(handler.seen).toEqual([]);
    expect(await journalFiles()).toEqual([`${messageId}.json`]);
  });

  it('delivers an orphan once when two queues claim it together', async () => {
    const messageId = 'msg_01JORPHANRACE000000000000';
    await writeOrphan({ messageId, attempt: 1, dueAt: Date.now() });

    const first = newQueue();
    const second = newQueue();
    const a = recordingHandler(first);
    const b = recordingHandler(second);
    await Promise.all([first.redeliverOrphans(), second.redeliverOrphans()]);

    await vi.waitFor(() =>
      expect([...a.seen, ...b.seen]).toEqual([{ messageId, attempt: 2 }])
    );
    await vi.waitFor(async () => expect(await journalFiles()).toEqual([]));
  });

  it('recovers only the messages of its own tag', async () => {
    const messageId = 'msg_01JORPHANTAGGED00000000000';
    await writeOrphan({ messageId, attempt: 1, dueAt: Date.now() }, 'vitest-1');

    const untagged = newQueue();
    const untaggedHandler = recordingHandler(untagged);
    await untagged.redeliverOrphans();
    await settle();
    expect(untaggedHandler.seen).toEqual([]);

    const tagged = newQueue({ tag: 'vitest-1' });
    const taggedHandler = recordingHandler(tagged);
    await tagged.redeliverOrphans();
    await vi.waitFor(() =>
      expect(taggedHandler.seen).toEqual([{ messageId, attempt: 2 }])
    );
  });

  it('keeps no journal when recovery is off', async () => {
    const messageId = 'msg_01JORPHANNORECOVERY0000000';
    await writeOrphan({ messageId, attempt: 1, dueAt: Date.now() });

    const queue = newQueue({ recover: false });
    const handler = recordingHandler(queue);
    await queue.queue('__wkf_workflow_test' as any, workflowPayload);
    await queue.redeliverOrphans();

    await vi.waitFor(() => expect(handler.seen).toHaveLength(1));
    // Only the orphan written above; the delivered message was never journaled.
    expect(await journalFiles()).toEqual([`${messageId}.json`]);
  });
});

describe('the local World and its queue journal', () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', undefined);
    dataDir = await mkdtemp(path.join(tmpdir(), 'wf-world-journal-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("start() redelivers a dead process's message as well as re-enqueueing its run", async () => {
    const setup = createWorld({ dataDir });
    await setup.start();
    const run = await createRun(setup, {
      deploymentId: 'dpl_1',
      workflowName: 'myWorkflow',
      input: new Uint8Array([1]),
    });
    await updateRun(setup, run.runId, 'run_started');
    await setup.close();

    const messageId = 'msg_01JWORLDORPHAN000000000000';
    await mkdir(path.join(dataDir, QUEUE_JOURNAL_DIR), { recursive: true });
    await writeFile(
      path.join(dataDir, QUEUE_JOURNAL_DIR, `${messageId}.json`),
      JSON.stringify({
        messageId,
        queueName: '__wkf_workflow_myWorkflow',
        body: JSON.stringify({ runId: run.runId }),
        attempt: 1,
        dueAt: Date.now(),
        holder: { pid: exitedPid(), host: hostname(), bootId: 'dead' },
      })
    );

    const world = createWorld({ dataDir });
    const seen: { messageId: string; attempt: number; runId: string }[] = [];
    world.registerHandler(
      '__wkf_workflow_',
      world.createQueueHandler('__wkf_workflow_', async (message, meta) => {
        seen.push({
          messageId: meta.messageId,
          attempt: meta.attempt,
          runId: (message as { runId: string }).runId,
        });
      })
    );
    try {
      await world.start();

      await vi.waitFor(() => expect(seen).toHaveLength(2));
      // The dead process's own message, so the runtime can recover what it
      // left running under it, and the re-enqueue of the run as a backstop.
      expect(seen).toContainEqual({ messageId, attempt: 2, runId: run.runId });
      expect(seen).toContainEqual({
        messageId: expect.not.stringMatching(messageId),
        attempt: 1,
        runId: run.runId,
      });
    } finally {
      await world.close();
    }
  });

  it("a tagged clear() forgets that tag's journaled messages", async () => {
    const world = createWorld({ dataDir, tag: 'vitest-9' });
    let release!: () => void;
    world.registerHandler(
      '__wkf_workflow_',
      world.createQueueHandler('__wkf_workflow_', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })
    );
    try {
      const { messageId } = await world.queue(
        '__wkf_workflow_test' as any,
        workflowPayload
      );
      const journalDir = path.join(dataDir, QUEUE_JOURNAL_DIR);
      expect(await readdir(journalDir)).toEqual([`${messageId}.vitest-9.json`]);

      await world.clear();

      expect(await readdir(journalDir)).toEqual([]);
    } finally {
      await vi.waitFor(() => expect(release).toBeDefined());
      release();
      await world.close();
    }
  });
});
