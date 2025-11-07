import { setWorld } from '@workflow/core/runtime';
import type {
  CreateEventRequest,
  CreateHookRequest,
  CreateStepRequest,
  CreateWorkflowRunRequest,
  Event,
  Hook,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunStepsParams,
  ListWorkflowRunsParams,
  MessageId,
  PaginatedResponse,
  QueuePayload,
  QueuePrefix,
  Step,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  ValidQueueName,
  WorkflowRun,
  World,
} from '@workflow/world';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import {
  cancelRun,
  closeStream,
  createEvent,
  createHook,
  createQueueHandler,
  createRun,
  createStep,
  disposeHook,
  getDeploymentId,
  getHook,
  getStep,
  getWorkflowRun,
  listEvents,
  listEventsByCorrelationId,
  listHooks,
  listRuns,
  listSteps,
  pauseRun,
  queue,
  readFromStream,
  resumeRun,
  startWorld,
  updateRun,
  updateStep,
  writeToStream,
} from './api';

// Utility types to strongly type the mocked World instance
type FnMock<T> = T extends (...args: infer A) => infer R ? Mock<A, R> : never;
type RunsMock = { [K in keyof World['runs']]: FnMock<World['runs'][K]> };
type StepsMock = { [K in keyof World['steps']]: FnMock<World['steps'][K]> };
type EventsMock = { [K in keyof World['events']]: FnMock<World['events'][K]> };
type HooksMock = { [K in keyof World['hooks']]: FnMock<World['hooks'][K]> };

interface InstrumentedWorld extends World {
  runs: RunsMock;
  steps: StepsMock;
  events: EventsMock;
  hooks: HooksMock;
  getDeploymentId: FnMock<World['getDeploymentId']>;
  queue: FnMock<World['queue']>;
  createQueueHandler: FnMock<World['createQueueHandler']>;
  writeToStream: FnMock<World['writeToStream']>;
  closeStream: FnMock<World['closeStream']>;
  readFromStream: FnMock<World['readFromStream']>;
  start?: FnMock<NonNullable<World['start']>>;
}

const sampleRun: WorkflowRun = {
  runId: 'run_123',
  deploymentId: 'dep_abc',
  status: 'running',
  workflowName: 'exampleWorkflow',
  executionContext: {},
  input: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const sampleStep: Step = {
  runId: 'run_123',
  stepId: 'step_1',
  stepName: 'Example Step',
  status: 'pending',
  input: [],
  attempt: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const sampleHook: Hook = {
  runId: 'run_123',
  hookId: 'hook_1',
  token: 'token',
  ownerId: 'owner',
  projectId: 'project',
  environment: 'development',
  createdAt: new Date(),
};

const sampleEvent: Event = {
  runId: 'run_123',
  eventId: 'event_1',
  eventType: 'workflow_started',
  createdAt: new Date(),
};

const paginate = <T>(data: T[]): PaginatedResponse<T> => ({
  data,
  cursor: null,
  hasMore: false,
});

function createMockWorld(): InstrumentedWorld {
  return {
    runs: {
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      list: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    },
    steps: {
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      list: vi.fn(),
    },
    events: {
      create: vi.fn(),
      list: vi.fn(),
      listByCorrelationId: vi.fn(),
    },
    hooks: {
      create: vi.fn(),
      get: vi.fn(),
      getByToken: vi.fn(),
      list: vi.fn(),
      dispose: vi.fn(),
    },
    getDeploymentId: vi.fn(),
    queue: vi.fn(),
    createQueueHandler: vi.fn(),
    writeToStream: vi.fn(),
    closeStream: vi.fn(),
    readFromStream: vi.fn(),
    start: vi.fn(),
  } as InstrumentedWorld;
}

describe('workflow/api world helpers', () => {
  let mockWorld: InstrumentedWorld;

  beforeEach(() => {
    mockWorld = createMockWorld();
    setWorld(mockWorld);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
  });

  it('delegates run helpers to the active world singleton', async () => {
    const createInput: CreateWorkflowRunRequest = {
      deploymentId: 'dep_abc',
      workflowName: 'exampleWorkflow',
      input: [],
    };
    const updateInput: UpdateWorkflowRunRequest = { status: 'completed' };
    const listParams: ListWorkflowRunsParams = {
      workflowName: 'exampleWorkflow',
    };

    mockWorld.runs.create.mockResolvedValue(sampleRun);
    mockWorld.runs.get.mockResolvedValue(sampleRun);
    mockWorld.runs.update.mockResolvedValue(sampleRun);
    mockWorld.runs.list.mockResolvedValue(paginate([sampleRun]));
    mockWorld.runs.cancel.mockResolvedValue(sampleRun);
    mockWorld.runs.pause.mockResolvedValue(sampleRun);
    mockWorld.runs.resume.mockResolvedValue(sampleRun);

    await expect(createRun(createInput)).resolves.toBe(sampleRun);
    expect(mockWorld.runs.create).toHaveBeenCalledWith(createInput);

    await expect(getWorkflowRun(sampleRun.runId, undefined)).resolves.toBe(
      sampleRun
    );
    expect(mockWorld.runs.get).toHaveBeenCalledWith(sampleRun.runId, undefined);

    await expect(updateRun(sampleRun.runId, updateInput)).resolves.toBe(
      sampleRun
    );
    expect(mockWorld.runs.update).toHaveBeenCalledWith(
      sampleRun.runId,
      updateInput
    );

    await expect(listRuns(listParams)).resolves.toEqual(paginate([sampleRun]));
    expect(mockWorld.runs.list).toHaveBeenCalledWith(listParams);

    await expect(cancelRun(sampleRun.runId)).resolves.toBe(sampleRun);
    expect(mockWorld.runs.cancel).toHaveBeenCalledWith(
      sampleRun.runId,
      undefined
    );

    await expect(pauseRun(sampleRun.runId)).resolves.toBe(sampleRun);
    expect(mockWorld.runs.pause).toHaveBeenCalledWith(
      sampleRun.runId,
      undefined
    );

    await expect(resumeRun(sampleRun.runId)).resolves.toBe(sampleRun);
    expect(mockWorld.runs.resume).toHaveBeenCalledWith(
      sampleRun.runId,
      undefined
    );
  });

  it('supports the “list runs then cancel” programmatic use case', async () => {
    mockWorld.runs.list.mockResolvedValue(paginate([sampleRun]));
    mockWorld.runs.cancel.mockResolvedValue(sampleRun);

    const runs = await listRuns();
    expect(runs.data[0].runId).toBe(sampleRun.runId);

    await cancelRun(sampleRun.runId);
    expect(mockWorld.runs.cancel).toHaveBeenCalledWith(
      sampleRun.runId,
      undefined
    );
  });

  it('delegates step helpers', async () => {
    const createStepInput: CreateStepRequest = {
      stepId: 'step_1',
      stepName: 'Example Step',
      input: [],
    };
    const updateStepInput: UpdateStepRequest = { status: 'completed' };
    const listStepsParams: ListWorkflowRunStepsParams = { runId: 'run_123' };

    mockWorld.steps.create.mockResolvedValue(sampleStep);
    mockWorld.steps.get.mockResolvedValue(sampleStep);
    mockWorld.steps.update.mockResolvedValue(sampleStep);
    mockWorld.steps.list.mockResolvedValue(paginate([sampleStep]));

    await expect(createStep(sampleRun.runId, createStepInput)).resolves.toBe(
      sampleStep
    );
    expect(mockWorld.steps.create).toHaveBeenCalledWith(
      sampleRun.runId,
      createStepInput
    );

    await expect(getStep(sampleRun.runId, sampleStep.stepId)).resolves.toBe(
      sampleStep
    );
    expect(mockWorld.steps.get).toHaveBeenCalledWith(
      sampleRun.runId,
      sampleStep.stepId,
      undefined
    );

    await expect(
      updateStep(sampleRun.runId, sampleStep.stepId, updateStepInput)
    ).resolves.toBe(sampleStep);
    expect(mockWorld.steps.update).toHaveBeenCalledWith(
      sampleRun.runId,
      sampleStep.stepId,
      updateStepInput
    );

    await expect(listSteps(listStepsParams)).resolves.toEqual(
      paginate([sampleStep])
    );
    expect(mockWorld.steps.list).toHaveBeenCalledWith(listStepsParams);
  });

  it('delegates event and hook helpers', async () => {
    const createEventInput: CreateEventRequest = {
      eventType: 'workflow_started',
    };
    const listEventParams: ListEventsParams = { runId: sampleRun.runId };
    const listByCorrelationParams: ListEventsByCorrelationIdParams = {
      correlationId: 'corr_1',
    };
    const createHookInput: CreateHookRequest = {
      hookId: 'hook_1',
      token: 'token',
    };
    const listHookParams: ListHooksParams = {};

    mockWorld.events.create.mockResolvedValue(sampleEvent);
    mockWorld.events.list.mockResolvedValue(paginate([sampleEvent]));
    mockWorld.events.listByCorrelationId.mockResolvedValue(
      paginate([sampleEvent])
    );

    mockWorld.hooks.create.mockResolvedValue(sampleHook);
    mockWorld.hooks.get.mockResolvedValue(sampleHook);
    mockWorld.hooks.list.mockResolvedValue(paginate([sampleHook]));
    mockWorld.hooks.dispose.mockResolvedValue(sampleHook);

    await expect(createEvent(sampleRun.runId, createEventInput)).resolves.toBe(
      sampleEvent
    );
    expect(mockWorld.events.create).toHaveBeenCalledWith(
      sampleRun.runId,
      createEventInput,
      undefined
    );

    await expect(listEvents(listEventParams)).resolves.toEqual(
      paginate([sampleEvent])
    );
    expect(mockWorld.events.list).toHaveBeenCalledWith(listEventParams);

    await expect(
      listEventsByCorrelationId(listByCorrelationParams)
    ).resolves.toEqual(paginate([sampleEvent]));
    expect(mockWorld.events.listByCorrelationId).toHaveBeenCalledWith(
      listByCorrelationParams
    );

    await expect(createHook(sampleRun.runId, createHookInput)).resolves.toBe(
      sampleHook
    );
    expect(mockWorld.hooks.create).toHaveBeenCalledWith(
      sampleRun.runId,
      createHookInput,
      undefined
    );

    await expect(getHook(sampleHook.hookId)).resolves.toBe(sampleHook);
    expect(mockWorld.hooks.get).toHaveBeenCalledWith(
      sampleHook.hookId,
      undefined
    );

    await expect(listHooks(listHookParams)).resolves.toEqual(
      paginate([sampleHook])
    );
    expect(mockWorld.hooks.list).toHaveBeenCalledWith(listHookParams);

    await expect(disposeHook(sampleHook.hookId)).resolves.toBe(sampleHook);
    expect(mockWorld.hooks.dispose).toHaveBeenCalledWith(
      sampleHook.hookId,
      undefined
    );
  });

  it('delegates queue, stream, and lifecycle helpers', async () => {
    const queueName = '__wkf_workflow_example' as ValidQueueName;
    const queuePayload: QueuePayload = { runId: sampleRun.runId };
    const queuePrefix = '__wkf_step_' as QueuePrefix;
    const messageHandler = vi.fn(async () => undefined);
    const queueHandler = vi.fn(
      async (_req: Request) => new Response(null, { status: 200 })
    );

    mockWorld.getDeploymentId.mockResolvedValue('dep_abc');
    mockWorld.queue.mockResolvedValue({ messageId: 'msg_1' as MessageId });
    mockWorld.createQueueHandler.mockReturnValue(queueHandler as any);
    mockWorld.writeToStream.mockResolvedValue();
    mockWorld.closeStream.mockResolvedValue();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    mockWorld.readFromStream.mockResolvedValue(stream);
    mockWorld.start?.mockResolvedValue(undefined);

    await expect(getDeploymentId()).resolves.toBe('dep_abc');
    expect(mockWorld.getDeploymentId).toHaveBeenCalledTimes(1);

    await expect(queue(queueName, queuePayload)).resolves.toEqual({
      messageId: 'msg_1',
    });
    expect(mockWorld.queue).toHaveBeenCalledWith(
      queueName,
      queuePayload,
      undefined
    );

    const createdHandler = createQueueHandler(queuePrefix, messageHandler);
    expect(mockWorld.createQueueHandler).toHaveBeenCalledWith(
      queuePrefix,
      messageHandler
    );
    expect(createdHandler).toBe(queueHandler);

    await writeToStream('stream_1', 'payload');
    expect(mockWorld.writeToStream).toHaveBeenCalledWith('stream_1', 'payload');

    await closeStream('stream_1');
    expect(mockWorld.closeStream).toHaveBeenCalledWith('stream_1');

    await expect(readFromStream('stream_1')).resolves.toBe(stream);
    expect(mockWorld.readFromStream).toHaveBeenCalledWith(
      'stream_1',
      undefined
    );

    await startWorld();
    expect(mockWorld.start).toHaveBeenCalledTimes(1);
  });
});
