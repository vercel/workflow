import { context, trace as otelTrace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { RUN_ERROR_CODES, WorkflowWorldError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { importKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import { workflowEntrypoint } from '../runtime.js';
import { deriveRunKeyPair } from '../sealed-box.js';
import {
  dehydrateDynamicWorkflowCode,
  dehydrateWorkflowArguments,
  sealTo,
} from '../serialization.js';
import { DYNAMIC_WORKFLOWS_ENV } from './constants.js';
import {
  compileDynamicWorkflow,
  type DynamicWorkflowMetadata,
} from './dynamic-workflow.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  otelTrace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
  otelTrace.disable();
});

const RUN_ID = 'wrun_01JDYNAMICDELIVERY000000000';
const KEY_MATERIAL = new Uint8Array(32).fill(0x42);
const STATIC_WORKFLOW_CODE = `async function staticWorkflow() { return 'static'; }
;globalThis.__private_workflows = new Map();
globalThis.__private_workflows.set('workflow//./src/static//staticWorkflow', staticWorkflow);`;

async function compileReturning(value: number) {
  return compileDynamicWorkflow(
    `async function workflow() { "use workflow"; return ${value}; }`,
    { steps: { noop: { stepId: 'step//./test//noop' } } }
  );
}

/**
 * Deliver one queue message for a run and record what the handler wrote.
 *
 * `storedCode` is the run's `dynamicWorkflowCode` on the snapshot the
 * `run_started` response returns; `readBackCode` is what `runs.get` returns
 * when the delivery has to read it from the run.
 */
async function deliver(options: {
  workflowName: string;
  executionContext: Record<string, unknown>;
  storedCode?: Uint8Array;
  readBack?: () => Promise<Partial<WorkflowRun>>;
  encryption?: boolean;
}) {
  const workflowRun: WorkflowRun = {
    runId: RUN_ID,
    workflowName: options.workflowName,
    status: 'running',
    input: await dehydrateWorkflowArguments([], RUN_ID, undefined, []),
    deploymentId: 'dpl_current',
    specVersion: SPEC_VERSION_CURRENT,
    executionContext: options.executionContext,
    ...(options.storedCode ? { dynamicWorkflowCode: options.storedCode } : {}),
    startedAt: new Date('2026-07-30T00:00:00.000Z'),
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    updatedAt: new Date('2026-07-30T00:00:00.000Z'),
  };

  const createdEvents: any[] = [];
  const eventsCreate = vi.fn(async (_runId: string, data: any) => {
    createdEvents.push(data);
    if (data.eventType === 'run_started') {
      return { run: workflowRun, events: [] as Event[] };
    }
    return {
      event: {
        eventId: `evnt_${createdEvents.length}`,
        runId: RUN_ID,
        createdAt: new Date(),
        ...data,
      },
    };
  });
  // Only a resolved read returns the stored code; the orchestrator's
  // identity read (`resolveData: 'none'`) does not touch it.
  const runsGet = vi.fn(
    async (_runId: string, params?: { resolveData?: string }) => ({
      ...workflowRun,
      ...(params?.resolveData === 'none' ? {} : await options.readBack?.()),
    })
  );

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId: vi.fn(async () => 'dpl_current'),
    createQueueHandler: vi.fn(
      (
        _prefix: string,
        handler: (message: unknown, metadata: unknown) => Promise<unknown>
      ) =>
        async () => {
          await handler(
            { runId: RUN_ID, requestedAt: new Date() },
            {
              requestId: 'req_test',
              attempt: 1,
              queueName: '__wkf_workflow_dynamic',
              messageId: 'msg_test',
            }
          );
          return new Response(null, { status: 204 });
        }
    ),
    events: {
      create: eventsCreate,
      list: vi.fn(async () => ({
        data: [] as Event[],
        hasMore: false,
        cursor: 'cursor_test',
      })),
    },
    runs: { get: runsGet },
    queue: vi.fn(async () => ({ messageId: null })),
    getEncryptionKeyForRun: vi.fn(async () =>
      options.encryption === false ? undefined : KEY_MATERIAL
    ),
  } as any);

  const response = await workflowEntrypoint(STATIC_WORKFLOW_CODE)(
    new Request('https://example.test')
  );
  const eventTypes = createdEvents.map((event) => event.eventType);
  const runFailed = createdEvents.find(
    (event) => event.eventType === 'run_failed'
  );
  return { response, eventTypes, runFailed, runsGet };
}

function contextFor(metadata: DynamicWorkflowMetadata, encryption = true) {
  return {
    features: { encryption },
    dynamicWorkflow: metadata,
  };
}

async function encryptedCode(code: string) {
  return dehydrateDynamicWorkflowCode(code, await importKey(KEY_MATERIAL));
}

describe('dynamic workflow delivery', () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  let runLogger: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, '1');
    errorLog = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    vi.spyOn(runtimeLogger, 'info').mockImplementation(() => {});
    // The per-run logger the handler scopes to this delivery.
    runLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      forRun: vi.fn(),
    };
    runLogger.child.mockReturnValue(runLogger);
    runLogger.forRun.mockReturnValue(runLogger);
    vi.spyOn(runtimeLogger, 'forRun').mockReturnValue(runLogger as never);
  });

  afterEach(() => {
    exporter.reset();
    setWorld(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function failureMessages(): string[] {
    return errorLog.mock.calls.map(([, metadata]) =>
      String((metadata as { error?: unknown } | undefined)?.error)
    );
  }

  it('executes encrypted stored code and records it on the span and in one log line', async () => {
    const compiled = await compileReturning(7);

    const { response, eventTypes } = await deliver({
      workflowName: compiled.workflowName,
      executionContext: contextFor(compiled.metadata),
      storedCode: await encryptedCode(compiled.workflowCode),
    });

    expect(response.status).toBe(204);
    expect(eventTypes).toContain('run_completed');
    expect(eventTypes).not.toContain('run_failed');

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith('workflow.execute'));
    expect(span?.attributes['workflow.dynamic']).toBe(true);
    expect(span?.attributes['workflow.dynamic.source_hash']).toBe(
      compiled.metadata.sourceHash
    );

    // Scoped to this run by `forRun`, once for the invocation.
    expect(runtimeLogger.forRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.anything()
    );
    const executionLogs = runLogger.info.mock.calls.filter(
      ([message]) => message === 'Executing stored dynamic workflow code'
    );
    expect(executionLogs).toEqual([
      [
        'Executing stored dynamic workflow code',
        { sourceHash: compiled.metadata.sourceHash },
      ],
    ]);
  });

  it('fails the run when this deployment has not opted in', async () => {
    vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, undefined);
    const compiled = await compileReturning(7);

    const { response, eventTypes, runFailed } = await deliver({
      workflowName: compiled.workflowName,
      executionContext: contextFor(compiled.metadata),
      storedCode: await encryptedCode(compiled.workflowCode),
    });

    // Acked, not thrown: a redelivery would reach the same verdict.
    expect(response.status).toBe(204);
    expect(eventTypes).not.toContain('run_completed');
    expect(runFailed?.eventData.errorCode).toBe(RUN_ERROR_CODES.RUNTIME_ERROR);
    expect(failureMessages().join('\n')).toMatch(
      /has not enabled dynamic workflows.*WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1/
    );
    expect(
      exporter
        .getFinishedSpans()
        .some((s) => s.attributes['workflow.dynamic'] === true)
    ).toBe(false);
  });

  it('fails a static run carrying a forged marker instead of retrying', async () => {
    const compiled = await compileReturning(7);

    const { response, eventTypes, runFailed, runsGet } = await deliver({
      workflowName: 'workflow//./src/static//staticWorkflow',
      executionContext: contextFor(compiled.metadata),
      storedCode: await encryptedCode(compiled.workflowCode),
    });

    expect(response.status).toBe(204);
    expect(eventTypes).not.toContain('run_completed');
    expect(runFailed?.eventData.errorCode).toBe(RUN_ERROR_CODES.RUNTIME_ERROR);
    expect(failureMessages().join('\n')).toMatch(
      /does not match the dynamic id/
    );
    expect(runsGet).toHaveBeenCalled();
  });

  it('fails the run when its stored code is missing', async () => {
    const compiled = await compileReturning(7);

    const { response, runFailed, runsGet } = await deliver({
      workflowName: compiled.workflowName,
      executionContext: contextFor(compiled.metadata),
      readBack: async () => ({}),
    });

    expect(response.status).toBe(204);
    expect(runsGet).toHaveBeenCalledWith(RUN_ID, { resolveData: 'all' });
    expect(runFailed?.eventData.errorCode).toBe(RUN_ERROR_CODES.RUNTIME_ERROR);
    expect(failureMessages().join('\n')).toMatch(
      /stored workflow code is missing/
    );
  });

  it('fails the run when its stored code is plaintext although it has a key', async () => {
    const compiled = await compileReturning(7);

    const { response, eventTypes, runFailed } = await deliver({
      workflowName: compiled.workflowName,
      executionContext: contextFor(compiled.metadata),
      storedCode: await dehydrateDynamicWorkflowCode(
        compiled.workflowCode,
        undefined
      ),
    });

    expect(response.status).toBe(204);
    expect(eventTypes).not.toContain('run_completed');
    expect(runFailed?.eventData.errorCode).toBe(RUN_ERROR_CODES.RUNTIME_ERROR);
    expect(failureMessages().join('\n')).toMatch(/must be encrypted.*"devl"/);
  });

  it('fails the run when its stored code is sealed to the run public key', async () => {
    const compiled = await compileReturning(7);
    const { publicKey } = await deriveRunKeyPair(KEY_MATERIAL);

    const { response, eventTypes, runFailed } = await deliver({
      workflowName: compiled.workflowName,
      executionContext: contextFor(compiled.metadata),
      storedCode: await dehydrateDynamicWorkflowCode(
        compiled.workflowCode,
        sealTo(publicKey)
      ),
    });

    expect(response.status).toBe(204);
    expect(eventTypes).not.toContain('run_completed');
    expect(runFailed?.eventData.errorCode).toBe(RUN_ERROR_CODES.RUNTIME_ERROR);
    expect(failureMessages().join('\n')).toMatch(/must be encrypted.*"encp"/);
  });

  it('executes plaintext stored code in a World without encryption', async () => {
    const compiled = await compileReturning(3);

    const { eventTypes } = await deliver({
      workflowName: compiled.workflowName,
      executionContext: contextFor(compiled.metadata, false),
      storedCode: await dehydrateDynamicWorkflowCode(
        compiled.workflowCode,
        undefined
      ),
      encryption: false,
    });

    expect(eventTypes).toContain('run_completed');
    expect(eventTypes).not.toContain('run_failed');
  });

  it('fails the run when reading the stored code back hits corrupt data', async () => {
    const compiled = await compileReturning(7);

    const { response, runFailed } = await deliver({
      workflowName: compiled.workflowName,
      executionContext: contextFor(compiled.metadata),
      readBack: async () => {
        throw new WorkflowWorldError('corrupt stored code', {
          code: 'WORLD_CONTRACT_ERROR',
        });
      },
    });

    expect(response.status).toBe(204);
    expect(runFailed?.eventData.errorCode).toBe(
      RUN_ERROR_CODES.WORLD_CONTRACT_ERROR
    );
  });

  it('redelivers when reading the stored code back fails transiently', async () => {
    const compiled = await compileReturning(7);

    await expect(
      deliver({
        workflowName: compiled.workflowName,
        executionContext: contextFor(compiled.metadata),
        readBack: async () => {
          throw new WorkflowWorldError('backend unavailable', { status: 503 });
        },
      })
    ).rejects.toThrow('backend unavailable');
  });
});
