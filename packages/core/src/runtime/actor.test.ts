import {
  ActorInvariantError,
  type ActorSnapshot,
  type World,
} from '@workflow/world';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replayWorkflow, resumeWorkflow } from '../workflow.js';
import { ActorCoordinator } from './actor.js';
import { executeStep } from './step-executor.js';
import { handleSuspension } from './suspension-handler.js';

vi.mock('../workflow.js', () => ({
  replayWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
}));
vi.mock('./suspension-handler.js', () => ({ handleSuspension: vi.fn() }));
vi.mock('./step-executor.js', () => ({ executeStep: vi.fn() }));
vi.mock('./world.js', () => ({
  runWithWorld: (_world: unknown, fn: () => unknown) => fn(),
}));

beforeEach(() => vi.clearAllMocks());

function fixture() {
  const snapshot: ActorSnapshot = {
    profile: 'actor-owner-v1',
    runId: 'wrun_test',
    deploymentId: 'dpl_test',
    head: 1,
    tenant: {
      ownerId: 'team_test',
      projectId: 'prj_test',
      environment: 'preview',
    },
    events: [
      {
        runId: 'wrun_test',
        eventId: `evnt_${'1'.padStart(26, '0')}`,
        createdAt: new Date(0),
        eventType: 'run_created',
        specVersion: 7,
        eventData: {
          deploymentId: 'dpl_test',
          workflowName: 'workflow//test//main',
          input: new Uint8Array(),
        },
      },
    ],
  };
  const receipts = new Map<string, any>();
  const exchange = vi.fn(async (request) => {
    if (snapshot.fault) throw new ActorInvariantError(snapshot.fault.message);
    if (receipts.has(request.operationId))
      return structuredClone(receipts.get(request.operationId));
    if (request.expectedHead !== snapshot.head)
      throw new ActorInvariantError('expected head mismatch');
    const events = request.events.map((event: object, i: number) => ({
      ...event,
      runId: snapshot.runId,
      eventId: `evnt_${String(snapshot.head + i + 1).padStart(26, '0')}`,
      createdAt: new Date(),
    }));
    snapshot.events.push(...events);
    snapshot.head += events.length;
    const receipt = {
      operationId: request.operationId,
      head: snapshot.head,
      events,
    };
    receipts.set(request.operationId, receipt);
    return structuredClone(receipt);
  });
  const quarantine = vi.fn(async (_id, fault) => {
    snapshot.fault = fault;
  });
  const world = {
    execution: {
      profile: 'actor-owner-v1',
      acquire: vi.fn(async () => structuredClone(snapshot)),
      exchange,
      quarantine,
      receipt: vi.fn(async (_id, op) => structuredClone(receipts.get(op))),
    },
    specVersion: 7,
    getDeploymentId: async () => 'dpl_test',
    events: {},
    runs: {},
    steps: {},
    queue: vi.fn(),
  } as unknown as World;
  return { world, snapshot, exchange, quarantine };
}

describe('actor coordinator commits', () => {
  it('serializes concurrent appends against successive heads', async () => {
    const f = fixture();
    const actor = new ActorCoordinator(f.world, 'wrun_test', '');
    await actor.initialize();
    await Promise.all([
      actor.append({ eventType: 'run_started', specVersion: 7 }),
      actor.append({
        eventType: 'wait_created',
        correlationId: 'wait_1',
        specVersion: 7,
        eventData: { resumeAt: new Date() },
      }),
    ]);
    expect(
      f.exchange.mock.calls.map(([request]) => request.expectedHead)
    ).toEqual([1, 2]);
    expect(f.quarantine).not.toHaveBeenCalled();
  });
  it('quarantines an unexpected head and never retries at another slot', async () => {
    const f = fixture();
    const actor = new ActorCoordinator(f.world, 'wrun_test', '');
    await actor.initialize();
    f.snapshot.head = 2;
    await expect(
      actor.append({ eventType: 'run_started', specVersion: 7 })
    ).rejects.toThrow('head mismatch');
    await expect(
      actor.append({ eventType: 'run_started', specVersion: 7 })
    ).rejects.toThrow();
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.quarantine).toHaveBeenCalledTimes(1);
    const replacement = new ActorCoordinator(f.world, 'wrun_test', '');
    await expect(replacement.initialize()).rejects.toThrow();
  });
  it('returns an exact duplicate submission without appending twice', async () => {
    const f = fixture();
    const actor = new ActorCoordinator(f.world, 'wrun_test', '');
    await actor.initialize();
    const event = { eventType: 'run_started' as const, specVersion: 7 };
    const first = await actor.append(event, 'op1');
    expect(await actor.append(event, 'op1')).toEqual(first);
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it('rejects the wrong deployment before running workflow code', async () => {
    const f = fixture();
    f.world.getDeploymentId = async () => 'dpl_other';
    await expect(
      new ActorCoordinator(f.world, 'wrun_test', '').initialize()
    ).rejects.toThrow('wrong deployment');
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.quarantine).toHaveBeenCalledOnce();
  });

  it('shares initialization and a workflow driver across concurrent arrivals', async () => {
    const f = fixture();
    const actor = new ActorCoordinator(f.world, 'wrun_test', '');
    vi.mocked(replayWorkflow).mockResolvedValueOnce({
      type: 'suspended',
      session: {},
      suspension: {},
    } as any);
    vi.mocked(handleSuspension).mockResolvedValueOnce({
      pendingSteps: [],
      lazyInlineSteps: [],
      serializationBlockerCount: 0,
    } as any);
    await Promise.all([actor.receive(), actor.receive(), actor.receive()]);
    expect(f.world.execution!.acquire).toHaveBeenCalledTimes(1);
    expect(replayWorkflow).toHaveBeenCalledTimes(1);
    expect(f.exchange).toHaveBeenCalledTimes(1); // run_started only
  });

  it('creates the step before inline execution and retains the VM to completion', async () => {
    const f = fixture();
    const actor = new ActorCoordinator(f.world, 'wrun_test', '');
    const session = {};
    vi.mocked(replayWorkflow).mockResolvedValueOnce({
      type: 'suspended',
      session,
      suspension: {},
    } as any);
    vi.mocked(handleSuspension).mockResolvedValueOnce({
      pendingSteps: [],
      serializationBlockerCount: 0,
      lazyInlineSteps: [
        {
          correlationId: 'step_1',
          stepName: 'step//test//one',
          dehydratedInput: new Uint8Array(),
        },
      ],
    } as any);
    vi.mocked(executeStep).mockImplementationOnce(
      async ({ world, suppressOptimisticStart }) => {
        expect(f.snapshot.events.at(-1)?.eventType).toBe('step_created');
        expect(suppressOptimisticStart).toBe(true);
        await world.events.create('wrun_test', {
          eventType: 'step_started',
          specVersion: 7,
          correlationId: 'step_1',
        });
        await world.events.create('wrun_test', {
          eventType: 'step_completed',
          specVersion: 7,
          correlationId: 'step_1',
          eventData: { result: new Uint8Array() },
        });
        return { type: 'completed' };
      }
    );
    vi.mocked(resumeWorkflow).mockResolvedValueOnce({
      type: 'completed',
      output: new Uint8Array(),
      resultType: 'object',
    });
    await actor.receive();
    expect(f.snapshot.events.map((e) => e.eventType)).toEqual([
      'run_created',
      'run_started',
      'step_created',
      'step_started',
      'step_completed',
      'run_completed',
    ]);
    expect(resumeWorkflow).toHaveBeenCalledWith(session, expect.any(Array));
    expect(f.world.queue).not.toHaveBeenCalled();
  });

  it('does not cold-replay or execute bodies when a retained session declines', async () => {
    const f = fixture();
    const actor = new ActorCoordinator(f.world, 'wrun_test', '');
    vi.mocked(replayWorkflow).mockResolvedValueOnce({
      type: 'suspended',
      session: {},
      suspension: {},
    } as any);
    vi.mocked(handleSuspension).mockResolvedValueOnce({
      pendingSteps: [],
      lazyInlineSteps: [],
      serializationBlockerCount: 0,
    } as any);
    await actor.receive();
    vi.mocked(resumeWorkflow).mockResolvedValueOnce({ type: 'replay' });
    await expect(actor.receive()).rejects.toThrow(
      'automatic replay is forbidden'
    );
    expect(replayWorkflow).toHaveBeenCalledTimes(1);
    expect(executeStep).not.toHaveBeenCalled();
    expect(f.quarantine).toHaveBeenCalledOnce();
  });
});
