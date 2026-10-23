import {
  EntityConflictError,
  FatalError,
  ThrottleError,
  WorkflowRunAlreadyStartedError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  WorkflowInvokePayloadSchema,
  type World,
} from '@workflow/world';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { isRetryableWorldError } from '../classify-error.js';
import { importKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import {
  base64ToBytes,
  bytesToBase64,
  deriveRunKeyPair,
  open,
  seal,
} from '../sealed-box.js';
import {
  hydrateWorkflowArguments,
  peekFormatPrefix,
  runPayloadKeys,
  SerializationFormat,
} from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import { serializeTraceCarrier, trace } from '../telemetry.js';
import { DYNAMIC_WORKFLOWS_ENV } from './constants.js';
import { getWorkflowQueueName } from './helpers.js';
import { Run } from './run.js';
import type { WorkflowFunction } from './start.js';
import { _resetLatestNoOpWarnForTests, start } from './start.js';
import { resolveIdempotencyOptions } from './start-idempotency.js';
import { setWorld } from './world.js';

// Mock @vercel/functions
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

// Mock telemetry
vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(undefined)),
  getActiveSpan: vi.fn().mockResolvedValue(undefined),
  // The argument-stream sinks record their flush and close spans.
  getSpanKind: vi.fn().mockResolvedValue(undefined),
  recordElapsedSpan: vi.fn().mockResolvedValue(undefined),
}));

describe('start', () => {
  describe('dynamic workflow preflight', () => {
    const source = 'async function workflow() { "use workflow"; return 1; }';
    let eventsCreate: ReturnType<typeof vi.fn>;
    let queue: ReturnType<typeof vi.fn>;
    let upload: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      eventsCreate = vi.fn();
      queue = vi.fn();
      upload = vi.fn();
      vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, '1');
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });

    describe('deployment opt-in', () => {
      function optInWorld() {
        return {
          specVersion: SPEC_VERSION_CURRENT,
          getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
          capabilities: { dynamicWorkflowCode: true },
          getEncryptionKeyForRun: vi.fn(),
          uploadDynamicWorkflowCode: upload,
          events: { create: eventsCreate },
          queue,
        } as any;
      }

      it.each([
        ['unset', undefined],
        ['empty', ''],
        ['0', '0'],
        ['false', 'false'],
        ['yes', 'yes'],
      ])('refuses a dynamic start with the opt-in %s, before any world call', async (_label, value) => {
        if (value === undefined) {
          vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, undefined);
        } else {
          vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, value);
        }
        const world = optInWorld();
        setWorld(world);

        const error = await start(source, {
          experimental_dynamic: {
            steps: { noop: { stepId: 'step//./test//noop' } },
          },
        }).catch((err: unknown) => err);

        expect(WorkflowRuntimeError.is(error)).toBe(true);
        expect((error as Error).message).toMatch(
          /Dynamic workflows are disabled on this deployment.*WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1/
        );
        expect(world.getDeploymentId).not.toHaveBeenCalled();
        expect(world.getEncryptionKeyForRun).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
        expect(eventsCreate).not.toHaveBeenCalled();
        expect(queue).not.toHaveBeenCalled();
      });

      it.each([
        '1',
        'true',
        'TRUE',
      ])('accepts the opt-in value %s', async (value) => {
        vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, value);
        eventsCreate.mockImplementation(async (runId, event) => ({
          run: {
            runId,
            status: 'pending',
            dynamicWorkflowCode: event.eventData.dynamicWorkflowCode,
          },
        }));
        queue.mockResolvedValue(undefined);
        setWorld(optInWorld());

        await expect(
          start(source, {
            experimental_dynamic: {
              steps: { noop: { stepId: 'step//./test//noop' } },
            },
          })
        ).resolves.toBeDefined();
        expect(eventsCreate).toHaveBeenCalledOnce();
        expect(queue).toHaveBeenCalledOnce();
      });
    });

    it.each([
      [
        'explicit resource management syntax',
        `async function workflow() {
  "use workflow";
  using resource = null;
  return resource;
}`,
      ],
      [
        'regular expression modifiers',
        `async function workflow() {
  "use workflow";
  return /(?i:a)/.test("A");
}`,
      ],
    ])('rejects unsupported %s before start side effects', async (_label, unsupportedSource) => {
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        capabilities: { dynamicWorkflowCode: true },
        uploadDynamicWorkflowCode: upload,
        events: { create: eventsCreate },
        queue,
      } as any);

      await expect(
        start(unsupportedSource, {
          experimental_dynamic: {
            steps: { noop: { stepId: 'step//./test//noop' } },
          },
        })
      ).rejects.toThrow(/not valid JavaScript/);
      expect(upload).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    it('rejects a $-prefixed export name before start side effects', async () => {
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        capabilities: { dynamicWorkflowCode: true },
        uploadDynamicWorkflowCode: upload,
        events: { create: eventsCreate },
        queue,
      } as any);

      await expect(
        start('async function $workflow() { "use workflow"; return 1; }', {
          experimental_dynamic: {
            exportName: '$workflow',
            steps: { noop: { stepId: 'step//./test//noop' } },
          },
        })
      ).rejects.toThrow(/cannot appear in workflow queue names/);
      expect(upload).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    it('validates the queue name before start side effects', async () => {
      const getDeploymentId = vi.fn().mockResolvedValue('deploy_123');
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId,
        events: { create: eventsCreate },
        queue,
      } as any);
      const invalidQueueWorkflow = Object.assign(async () => undefined, {
        workflowId: 'workflow//./test//$invalid',
      });

      await expect(start(invalidQueueWorkflow as never, [])).rejects.toThrow(
        /Invalid workflow name/
      );
      expect(getDeploymentId).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    describe('same-deployment only', () => {
      const dynamicSteps = {
        steps: { noop: { stepId: 'step//./test//noop' } },
      };

      function dynamicWorld(overrides: Record<string, unknown>) {
        return {
          specVersion: SPEC_VERSION_CURRENT,
          getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
          capabilities: { dynamicWorkflowCode: true },
          getEncryptionKeyForRun: vi.fn(),
          uploadDynamicWorkflowCode: upload,
          events: { create: eventsCreate },
          queue,
          streams: { get: vi.fn() },
          ...overrides,
        } as any;
      }

      function expectNoSideEffects(world: any) {
        // No capability probe (a queue call), no key lookup, no upload, and
        // no run creation.
        expect(queue).not.toHaveBeenCalled();
        expect(world.streams.get).not.toHaveBeenCalled();
        expect(world.getEncryptionKeyForRun).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
        expect(eventsCreate).not.toHaveBeenCalled();
      }

      it('rejects an explicit other deployment before probing it', async () => {
        const world = dynamicWorld({});
        setWorld(world);

        const error = await start(source, {
          deploymentId: 'dpl_other',
          experimental_dynamic: dynamicSteps,
        }).catch((err: unknown) => err);

        expect(WorkflowRuntimeError.is(error)).toBe(true);
        expect((error as Error).message).toMatch(
          /only start on the current deployment.*"dpl_other" from "deploy_123"/
        );
        expectNoSideEffects(world);
      });

      it("rejects 'latest' when it resolves to another deployment", async () => {
        const world = dynamicWorld({
          resolveLatestDeploymentId: vi.fn().mockResolvedValue('dpl_newer'),
        });
        setWorld(world);

        await expect(
          start(source, {
            deploymentId: 'latest',
            experimental_dynamic: dynamicSteps,
          })
        ).rejects.toThrow(/only start on the current deployment.*"dpl_newer"/);
        expectNoSideEffects(world);
      });

      it('rejects a concrete target when the current deployment is unknown', async () => {
        const world = dynamicWorld({
          getDeploymentId: vi
            .fn()
            .mockRejectedValue(new Error('no current deployment')),
        });
        setWorld(world);

        await expect(
          start(source, {
            deploymentId: 'deploy_123',
            experimental_dynamic: dynamicSteps,
          })
        ).rejects.toThrow(
          /only start on the current deployment.*an unknown current deployment/
        );
        expectNoSideEffects(world);
      });

      it('accepts an explicit deploymentId naming the current deployment', async () => {
        eventsCreate.mockImplementation(async (runId, event) => ({
          run: {
            runId,
            status: 'pending',
            dynamicWorkflowCode: event.eventData.dynamicWorkflowCode,
          },
        }));
        queue.mockResolvedValue(undefined);
        const world = dynamicWorld({});
        setWorld(world);

        await expect(
          start(source, {
            deploymentId: 'deploy_123',
            experimental_dynamic: dynamicSteps,
          })
        ).resolves.toBeDefined();
        // Same deployment: no capability probe, only the run's own queue
        // message.
        expect(world.streams.get).not.toHaveBeenCalled();
        expect(queue).toHaveBeenCalledOnce();
        expect(queue.mock.calls[0][0]).toContain('workflow//dynamic/');
      });
    });

    it.each([
      [
        'nested declaration',
        'function outer() { async function workflow() { "use workflow"; } }',
      ],
      [
        'comment spoof',
        '// async function workflow() { "use workflow"; }\nconst value = 1;',
      ],
      [
        'string spoof',
        'const value = `async function workflow() { "use workflow"; }`;',
      ],
    ])('rejects a %s before start side effects', async (_label, invalidSource) => {
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        capabilities: { dynamicWorkflowCode: true },
        uploadDynamicWorkflowCode: upload,
        events: { create: eventsCreate },
        queue,
      } as any);

      await expect(
        start(invalidSource, {
          experimental_dynamic: {
            steps: { noop: { stepId: 'step//./test//noop' } },
          },
        })
      ).rejects.toThrow(/at top level/);
      expect(upload).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    it.each([
      ['Object', 'const Object = null;'],
      ['Map', 'let Map = null;'],
      ['Symbol', 'function Symbol() {}'],
      ['globalThis', 'var globalThis = null;'],
      ['__dynamicUseStep', 'const __dynamicUseStep = null;'],
      ['__dynamicWorkflow', 'let __dynamicWorkflow = null;'],
      ['__dynamicGlobalThis', 'function __dynamicGlobalThis() {}'],
      ['steps', 'var steps = null;'],
      ['sleep', 'const sleep = null;'],
      ['createHook', 'let createHook = null;'],
      ['Error', 'class Error {}'],
    ])('starts safely with caller %s declarations', async (_binding, declaration) => {
      eventsCreate.mockImplementation(async (runId, event) => ({
        run: {
          runId,
          status: 'pending',
          dynamicWorkflowCode: event.eventData.dynamicWorkflowCode,
        },
      }));
      queue.mockResolvedValue(undefined);
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        capabilities: { dynamicWorkflowCode: true },
        uploadDynamicWorkflowCode: upload,
        events: { create: eventsCreate },
        queue,
      } as any);
      const isolatedSource = `
${declaration}
async function workflow() {
  "use workflow";
  return 1;
}
`;

      await expect(
        start(isolatedSource, {
          experimental_dynamic: {
            steps: { noop: { stepId: 'step//./test//noop' } },
          },
        })
      ).resolves.toBeDefined();
      expect(upload).not.toHaveBeenCalled();
      expect(eventsCreate).toHaveBeenCalledOnce();
      expect(queue).toHaveBeenCalledOnce();
    });

    it('allows a genuine top-level declaration to reach start side effects', async () => {
      eventsCreate.mockImplementation(async (runId, event) => ({
        run: {
          runId,
          status: 'pending',
          dynamicWorkflowCode: event.eventData.dynamicWorkflowCode,
        },
      }));
      queue.mockResolvedValue(undefined);
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        capabilities: { dynamicWorkflowCode: true },
        events: { create: eventsCreate },
        queue,
      } as any);

      await expect(
        start(source, {
          experimental_dynamic: {
            steps: { noop: { stepId: 'step//./test//noop' } },
          },
        })
      ).resolves.toBeDefined();
      expect(eventsCreate).toHaveBeenCalledOnce();
      expect(queue).toHaveBeenCalledOnce();
    });

    it.each([
      ['no capabilities', undefined],
      ['capabilities without the flag', { hookRetention: { active: true } }],
    ])('rejects a World with %s before start side effects', async (_label, capabilities) => {
      // A World with an upload path but no declared capability is still
      // refused: the upload is an optional size escape hatch, not the signal.
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        getEncryptionKeyForRun: vi.fn(),
        uploadDynamicWorkflowCode: upload,
        capabilities,
        events: { create: eventsCreate },
        queue,
      } as any);

      await expect(
        start(source, {
          experimental_dynamic: {
            steps: { noop: { stepId: 'step//./test//noop' } },
          },
        })
      ).rejects.toThrow(/capabilities\.dynamicWorkflowCode/);
      expect(upload).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    it('rejects execution-context validation before upload, create, or queue', async () => {
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        capabilities: { dynamicWorkflowCode: true },
        validateRunExecutionContext: vi.fn(() => {
          throw new Error('execution context too large');
        }),
        uploadDynamicWorkflowCode: upload,
        events: { create: eventsCreate },
        queue,
      } as any);

      await expect(
        start(source, {
          experimental_dynamic: {
            steps: { noop: { stepId: 'step//./test//noop' } },
          },
        })
      ).rejects.toThrow('execution context too large');
      expect(upload).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    describe('publishes only a run whose code was stored', () => {
      const dynamicOptions = {
        experimental_dynamic: {
          steps: { noop: { stepId: 'step//./test//noop' } },
        },
      };

      function storingWorld(overrides: Record<string, unknown> = {}) {
        return {
          specVersion: SPEC_VERSION_CURRENT,
          getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
          capabilities: { dynamicWorkflowCode: true },
          events: { create: eventsCreate },
          queue,
          ...overrides,
        } as any;
      }

      function echoStoredCode() {
        eventsCreate.mockImplementation(async (runId, event) => ({
          run: {
            runId,
            status: 'pending',
            dynamicWorkflowCode: event.eventData.dynamicWorkflowCode,
          },
        }));
      }

      beforeEach(() => {
        queue.mockResolvedValue({ messageId: 'msg_1' });
      });

      it('publishes only after run_created has confirmed the code', async () => {
        let created = false;
        eventsCreate.mockImplementation(async (runId, event) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          created = true;
          return {
            run: {
              runId,
              status: 'pending',
              dynamicWorkflowCode: event.eventData.dynamicWorkflowCode,
            },
          };
        });
        queue.mockImplementation(async () => {
          expect(created).toBe(true);
          return { messageId: 'msg_1' };
        });
        setWorld(storingWorld());

        const run = await start(source, dynamicOptions);

        expect(queue).toHaveBeenCalledOnce();
        expect(queue.mock.calls[0][1].runInput.dynamicWorkflowCode).toEqual(
          eventsCreate.mock.calls[0][1].eventData.dynamicWorkflowCode
        );
        expect(run.runId).toBe(eventsCreate.mock.calls[0][0]);
      });

      it('publishes nothing when the backend drops the code', async () => {
        eventsCreate.mockImplementation(async (runId) => ({
          run: { runId, status: 'pending' },
        }));
        setWorld(storingWorld());

        const error = await start(source, dynamicOptions).catch(
          (err: unknown) => err
        );

        expect(WorkflowRuntimeError.is(error)).toBe(true);
        expect((error as Error).message).toMatch(
          /was created, but this deployment's Workflow backend did not store its dynamic workflow code.*It was not queued, so it will not execute/
        );
        expect(queue).not.toHaveBeenCalled();
      });

      it('publishes nothing when run_created is rejected with a 400', async () => {
        const rejected = new WorkflowWorldError(
          'dynamic workflow storage is not enabled for this project',
          { status: 400, code: 'dynamic-workflow-storage-disabled' }
        );
        eventsCreate.mockRejectedValue(rejected);
        setWorld(storingWorld());

        await expect(start(source, dynamicOptions)).rejects.toBe(rejected);
        expect(queue).not.toHaveBeenCalled();
      });

      it.each([
        [
          '500',
          () =>
            new WorkflowWorldError('Internal Server Error', { status: 500 }),
        ],
        ['429', () => new ThrottleError('Too Many Requests')],
      ])('publishes nothing when run_created fails with a retryable %s', async (_label, makeError) => {
        const failure = makeError();
        eventsCreate.mockRejectedValue(failure);
        setWorld(storingWorld());

        // Unlike a static start, which publishes anyway and lets the first
        // delivery re-create the run, the error reaches the caller.
        await expect(start(source, dynamicOptions)).rejects.toBe(failure);
        expect(queue).not.toHaveBeenCalled();
      });

      it('publishes nothing when run_created conflicts', async () => {
        // Nothing reads the existing run back: a dynamic create that does not
        // cleanly succeed is thrown, whatever the reason.
        const conflict = new EntityConflictError('Run already exists');
        eventsCreate.mockRejectedValue(conflict);
        setWorld(storingWorld());

        await expect(start(source, dynamicOptions)).rejects.toBe(conflict);
        expect(queue).not.toHaveBeenCalled();
      });

      it('throws when the queue rejects after the code was stored', async () => {
        echoStoredCode();
        queue.mockRejectedValue(new Error('Queue unavailable'));
        setWorld(storingWorld());

        await expect(start(source, dynamicOptions)).rejects.toThrow(
          'Queue unavailable'
        );
        expect(eventsCreate).toHaveBeenCalledOnce();
      });
    });

    describe('refusals are fatal', () => {
      const steps = { noop: { stepId: 'step//./test//noop' } };

      function refusingWorld(overrides: Record<string, unknown> = {}) {
        return {
          specVersion: SPEC_VERSION_CURRENT,
          getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
          capabilities: { dynamicWorkflowCode: true },
          events: { create: eventsCreate },
          queue,
          ...overrides,
        } as any;
      }

      it.each<[string, () => Promise<unknown>, RegExp]>([
        [
          'the opt-in is off',
          () => {
            vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, undefined);
            return start(source, { experimental_dynamic: { steps } });
          },
          /Dynamic workflows are disabled on this deployment/,
        ],
        [
          'experimental_dynamic is missing',
          () => start(source as never, []),
          /no `experimental_dynamic` options/,
        ],
        [
          'the source is invalid',
          () =>
            start('async function workflow() {', {
              experimental_dynamic: { steps },
            }),
          /not valid JavaScript/,
        ],
        [
          'the steps are empty',
          () => start(source, { experimental_dynamic: { steps: {} } }),
          /at least one registered step/,
        ],
        [
          'the target is another deployment',
          () =>
            start(source, {
              deploymentId: 'dpl_other',
              experimental_dynamic: { steps },
            }),
          /only start on the current deployment/,
        ],
        [
          'the World lacks the capability',
          () => {
            setWorld(refusingWorld({ capabilities: undefined }));
            return start(source, { experimental_dynamic: { steps } });
          },
          /capabilities\.dynamicWorkflowCode/,
        ],
        [
          'the execution context is over budget',
          () => {
            setWorld(
              refusingWorld({
                validateRunExecutionContext: () => {
                  throw new WorkflowRuntimeError('execution context too large');
                },
              })
            );
            return start(source, { experimental_dynamic: { steps } });
          },
          /execution context too large/,
        ],
      ])('when %s', async (_label, startIt, message) => {
        setWorld(refusingWorld());

        const error = await startIt().catch((err: unknown) => err);

        // Same type and message as before; `fatal` is what makes a step that
        // calls `start()` fail instead of retrying a refusal.
        expect(WorkflowRuntimeError.is(error)).toBe(true);
        expect((error as Error).message).toMatch(message);
        expect(FatalError.is(error)).toBe(true);
        expect(eventsCreate).not.toHaveBeenCalled();
        expect(queue).not.toHaveBeenCalled();
      });

      it.each([
        ['a plain Error', () => new Error('too large')],
        ['a frozen Error', () => Object.freeze(new Error('too large'))],
        ['a string', () => 'too large'],
      ])('turns a World throwing %s into a fatal refusal without mutating it', async (_label, makeThrown) => {
        const thrown = makeThrown();
        setWorld(
          refusingWorld({
            validateRunExecutionContext: () => {
              throw thrown;
            },
          })
        );

        const error = await start(source, {
          experimental_dynamic: { steps },
        }).catch((err: unknown) => err);

        expect(WorkflowRuntimeError.is(error)).toBe(true);
        expect((error as Error).message).toBe('too large');
        expect((error as Error).cause).toBe(thrown);
        expect(FatalError.is(error)).toBe(true);
        if (typeof thrown === 'object') {
          expect((thrown as { fatal?: unknown }).fatal).toBeUndefined();
        }
      });

      it('keeps an unknown current deployment retryable', async () => {
        // The lookup may fail transiently and match on a retry, so only a
        // confirmed mismatch is a refusal.
        setWorld(
          refusingWorld({
            getDeploymentId: vi
              .fn()
              .mockRejectedValue(new Error('lookup unavailable')),
          })
        );

        const error = await start(source, {
          deploymentId: 'deploy_123',
          experimental_dynamic: { steps },
        }).catch((err: unknown) => err);

        expect((error as Error).message).toMatch(
          /only start on the current deployment.*an unknown current deployment/
        );
        expect(FatalError.is(error)).toBe(false);
      });
    });

    it('does not apply execution-context validation to static starts', async () => {
      const validateRunExecutionContext = vi.fn(() => {
        throw new Error('execution context too large');
      });
      eventsCreate.mockImplementation(async (runId) => ({
        run: { runId, status: 'pending' },
      }));
      queue.mockResolvedValue(undefined);
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        validateRunExecutionContext,
        events: { create: eventsCreate },
        queue,
      } as any);
      const staticWorkflow = Object.assign(async () => undefined, {
        workflowId: 'workflow//./test//staticWorkflow',
      });

      // A large trace carrier (baggage / tracestate) is the static-start
      // shape that could approach a World's execution-context limit.
      const traceCarrier = { tracestate: 'x'.repeat(4096) };
      vi.mocked(serializeTraceCarrier).mockResolvedValueOnce(traceCarrier);

      await expect(start(staticWorkflow as never, [])).resolves.toBeDefined();
      expect(validateRunExecutionContext).not.toHaveBeenCalled();
      expect(eventsCreate).toHaveBeenCalledOnce();
      expect(
        eventsCreate.mock.calls[0][1].eventData.executionContext.traceCarrier
      ).toEqual(traceCarrier);
      expect(queue).toHaveBeenCalledOnce();
    });
  });

  describe('error handling', () => {
    it('requires experimental_dynamic for source at runtime', async () => {
      await expect(
        start('async function workflow() { "use workflow"; }' as never, [])
      ).rejects.toThrow(/no `experimental_dynamic` options/);
    });

    it('should throw WorkflowRuntimeError when workflow is undefined', async () => {
      await expect(
        // @ts-expect-error - intentionally passing undefined
        start(undefined, [])
      ).rejects.toThrow(WorkflowRuntimeError);

      await expect(
        // @ts-expect-error - intentionally passing undefined
        start(undefined, [])
      ).rejects.toThrow(
        `'start' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.`
      );
    });

    it('should throw WorkflowRuntimeError when workflow is null', async () => {
      await expect(
        // @ts-expect-error - intentionally passing null
        start(null, [])
      ).rejects.toThrow(WorkflowRuntimeError);

      await expect(
        // @ts-expect-error - intentionally passing null
        start(null, [])
      ).rejects.toThrow(
        `'start' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.`
      );
    });

    it('should throw WorkflowRuntimeError when workflow has no workflowId', async () => {
      const invalidWorkflow = () => Promise.resolve('result');

      await expect(start(invalidWorkflow, [])).rejects.toThrow(
        WorkflowRuntimeError
      );

      await expect(start(invalidWorkflow, [])).rejects.toThrow(
        `'start' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.`
      );
    });

    it('should throw WorkflowRuntimeError when workflow has empty string workflowId', async () => {
      const invalidWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: '',
      });

      await expect(start(invalidWorkflow, [])).rejects.toThrow(
        WorkflowRuntimeError
      );
    });
  });

  describe('specVersion', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('rejects worlds that do not declare a specVersion', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await expect(start(validWorkflow, [])).rejects.toThrow(
        'supports Worlds with spec version'
      );
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('uses world.specVersion when available', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await start(validWorkflow, []);

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          specVersion: SPEC_VERSION_CURRENT,
        }),
        expect.objectContaining({
          v1Compat: false,
        })
      );
    });

    it('rejects worlds whose declared specVersion is older than the runtime', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await expect(start(validWorkflow, [])).rejects.toThrow(
        'supports Worlds with spec version'
      );
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('rejects worlds whose declared specVersion is newer than the runtime', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        specVersion: SPEC_VERSION_MAX_SUPPORTED + 1,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await expect(start(validWorkflow, [])).rejects.toThrow(
        'supports Worlds with spec version'
      );
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('accepts a world switched back to the pre-sealed-log version', async () => {
      // What `WORKFLOW_SEALED_LOG=0` produces: `mintedSpecVersion()` answers
      // the slot-identity version, so the World declares one BELOW the version
      // this runtime stamps by default. The runtime has to admit it, or the
      // kill switch would reject the very World it selects and a rollback
      // would surface as a startup failure instead.
      const rolledBack = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await start(rolledBack, []);

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
        }),
        expect.anything()
      );
    });

    it('accepts a world that declares the ceiling version', async () => {
      // The default and the ceiling coincide at the sealed log, so what this
      // pins is that a World declaring the ceiling is admitted and its own
      // declaration is what gets stamped, not this runtime's default.
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        specVersion: SPEC_VERSION_MAX_SUPPORTED,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await start(validWorkflow, []);

      // The declared version is what gets stamped on `run_created`, which is
      // what pins the run's id scheme for the rest of its life.
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          specVersion: SPEC_VERSION_MAX_SUPPORTED,
        }),
        expect.anything()
      );
    });

    it('should use provided specVersion when passed in options', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await start(validWorkflow, [], { specVersion: SPEC_VERSION_LEGACY });

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          specVersion: SPEC_VERSION_LEGACY,
        }),
        expect.objectContaining({
          v1Compat: true,
        })
      );
    });

    it('should use provided specVersion with v1Compat true for legacy versions', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await start(validWorkflow, [], { specVersion: 1 });

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          specVersion: 1,
        }),
        expect.objectContaining({
          v1Compat: true,
        })
      );
    });

    it('seeds initial attributes on run_created and resilient run input for v4', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await start(validWorkflow, [], {
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
        attributes: { tenant: 't1' },
      });

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          eventData: expect.objectContaining({
            attributes: { tenant: 't1' },
          }),
        }),
        expect.anything()
      );
      expect(mockQueue.mock.calls[0]?.[1].runInput.attributes).toEqual({
        tenant: 't1',
      });
      // The reserved-namespace escape hatch was not requested, so the
      // flag must not appear on either payload.
      expect(mockEventsCreate.mock.calls[0]?.[1].eventData).not.toHaveProperty(
        'allowReservedAttributes'
      );
      expect(mockQueue.mock.calls[0]?.[1].runInput).not.toHaveProperty(
        'allowReservedAttributes'
      );
    });

    it("stamps the world's environment into the queued runInput", async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        getEnvironment: () => 'preview',
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await start(validWorkflow, []);

      expect(mockQueue.mock.calls[0]?.[1].runInput.environment).toBe('preview');
      // The backend already knows which tenant it authenticated for the
      // run_created write, so stamping it there would be redundant — and it is
      // only ever needed on the resilient-start path the queue message drives.
      expect(mockEventsCreate.mock.calls[0]?.[1].eventData).not.toHaveProperty(
        'environment'
      );
    });

    it('omits environment when the world does not report one', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        getEnvironment: () => undefined,
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await start(validWorkflow, []);

      expect(mockQueue.mock.calls[0]?.[1].runInput).not.toHaveProperty(
        'environment'
      );
    });

    it('omits environment for worlds that do not implement getEnvironment', async () => {
      // Local and Postgres have a single tenant, so they never implement it and
      // the consumer-side check has nothing to compare.
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await start(validWorkflow, []);

      expect(mockQueue.mock.calls[0]?.[1].runInput).not.toHaveProperty(
        'environment'
      );
    });

    it('rejects initial attributes for pre-v4 runs', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await expect(
        start(validWorkflow, [], {
          specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
          attributes: { tenant: 't1' },
        })
      ).rejects.toThrow(/spec version 4/);
    });

    it('rejects non-string initial attribute values', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(
        start(validWorkflow, [], {
          attributes: { tenant: undefined } as any,
        })
      ).rejects.toThrow(/must be a string value/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it('rejects reserved-prefix initial attribute keys with guidance', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(
        start(validWorkflow, [], { attributes: { $system: 'x' } })
      ).rejects.toThrow(/reserved prefix/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it('seeds reserved-prefix initial attributes with allowReservedAttributes and forwards the flag on both payloads', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await start(validWorkflow, [], {
        attributes: { $rootRunId: 'wrun_root', tenant: 't1' },
        allowReservedAttributes: true,
      });

      // run_created carries the attributes and the flag, so server-side
      // validation permits the reserved keys the same way the client did.
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          eventData: expect.objectContaining({
            attributes: { $rootRunId: 'wrun_root', tenant: 't1' },
            allowReservedAttributes: true,
          }),
        }),
        expect.anything()
      );
      // The resilient-start queue input carries both too, so a run
      // bootstrapped from run_started validates identically.
      expect(mockQueue.mock.calls[0]?.[1].runInput).toEqual(
        expect.objectContaining({
          attributes: { $rootRunId: 'wrun_root', tenant: 't1' },
          allowReservedAttributes: true,
        })
      );
    });

    it('still enforces non-reserved validation rules when allowReservedAttributes is set', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(
        start(validWorkflow, [], {
          attributes: { $note: 'v'.repeat(257) },
          allowReservedAttributes: true,
        })
      ).rejects.toThrow(/exceeds limit 256/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it('rejects oversized initial attribute keys, values, and batches before any write', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(
        start(validWorkflow, [], {
          attributes: { ['k'.repeat(257)]: 'v' },
        })
      ).rejects.toThrow(/exceeds limit 256/);

      await expect(
        start(validWorkflow, [], {
          attributes: { note: 'v'.repeat(257) },
        })
      ).rejects.toThrow(/exceeds limit 256/);

      const overCap: Record<string, string> = {};
      for (let i = 0; i <= 64; i++) overCap[`key_${i}`] = 'v';
      await expect(
        start(validWorkflow, [], { attributes: overCap })
      ).rejects.toThrow(/exceed limit 64/);

      expect(mockEventsCreate).not.toHaveBeenCalled();
    });
  });

  describe('encryption', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;
    let mockGetEncryptionKeyForRun: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);
      mockGetEncryptionKeyForRun = vi.fn().mockResolvedValue(undefined);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_resolved'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        getEncryptionKeyForRun: mockGetEncryptionKeyForRun,
      });
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('should pass resolved deploymentId to getEncryptionKeyForRun even when not in opts', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      // Call start() without explicit deploymentId in options — it should
      // be resolved from world.getDeploymentId() and forwarded to
      // getEncryptionKeyForRun so the key can be fetched.
      await start(validWorkflow, []);

      expect(mockGetEncryptionKeyForRun).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          deploymentId: 'deploy_resolved',
        })
      );
    });

    it('should pass explicit deploymentId from opts to getEncryptionKeyForRun', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await start(validWorkflow, [], { deploymentId: 'deploy_explicit' });

      expect(mockGetEncryptionKeyForRun).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          deploymentId: 'deploy_explicit',
        })
      );
    });

    describe('encryptionPublicKey stamping', () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      function stampedKey(): string | undefined {
        return mockEventsCreate.mock.calls[0][1].eventData.encryptionPublicKey;
      }

      it('stamps the run public key derived from the per-run key material', async () => {
        const material = new Uint8Array(32).fill(0x5a);
        mockGetEncryptionKeyForRun.mockResolvedValue(material);

        await start(validWorkflow, []);

        const runId = mockEventsCreate.mock.calls[0][0];
        const expected = bytesToBase64(
          (await deriveRunKeyPair(material)).publicKey
        );

        // The stamped key must be exactly what the owning deployment will
        // re-derive from the same material at resume time — otherwise sealed
        // payloads would be addressed to a key nobody holds the scalar for.
        expect(stampedKey()).toBe(expected);
        expect(runId).toMatch(/^wrun_/);
      });

      it('publishes a key that actually opens payloads sealed to it', async () => {
        // End-to-end proof that the published key is usable: seal to the
        // stamped value, then open with the keypair the run's own deployment
        // would derive.
        const material = new Uint8Array(32).fill(0x11);
        mockGetEncryptionKeyForRun.mockResolvedValue(material);

        await start(validWorkflow, []);

        const publicKey = base64ToBytes(stampedKey()!);
        expect(publicKey).toBeDefined();

        const plaintext = new TextEncoder().encode('sealed by a stranger');
        const sealed = await seal(publicKey!, plaintext);
        const opened = await open(await deriveRunKeyPair(material), sealed);
        expect(new TextDecoder().decode(opened)).toBe('sealed by a stranger');
      });

      it('omits the public key when encryption is disabled', async () => {
        // No key material means encryption is off for this run; stamping a
        // key would advertise a sealing capability the run cannot honor.
        mockGetEncryptionKeyForRun.mockResolvedValue(undefined);

        await start(validWorkflow, []);

        expect(stampedKey()).toBeUndefined();
        expect(
          'encryptionPublicKey' in mockEventsCreate.mock.calls[0][1].eventData
        ).toBe(false);
      });

      it('mirrors the public key onto the queued runInput for resilient start', async () => {
        // If the run_created write fails, the server recreates the run from
        // the queue payload. Without the key there, such a run would silently
        // lose the ability to receive sealed writes.
        const material = new Uint8Array(32).fill(0x77);
        mockGetEncryptionKeyForRun.mockResolvedValue(material);

        await start(validWorkflow, []);

        const queuePayload = mockQueue.mock.calls[0][1];
        expect(queuePayload.runInput.encryptionPublicKey).toBe(stampedKey());
      });

      it('derives distinct public keys for distinct runs', async () => {
        // Per-run isolation: two runs on the same deployment get different
        // key material, so their public keys must differ too.
        mockGetEncryptionKeyForRun.mockImplementation(async (runId: string) => {
          const material = new Uint8Array(32);
          material.set(new TextEncoder().encode(runId.slice(-8)));
          return material;
        });

        await start(validWorkflow, []);
        await start(validWorkflow, []);

        const first = mockEventsCreate.mock.calls[0][1].eventData;
        const second = mockEventsCreate.mock.calls[1][1].eventData;
        expect(first.encryptionPublicKey).toBeDefined();
        expect(second.encryptionPublicKey).toBeDefined();
        expect(first.encryptionPublicKey).not.toBe(second.encryptionPublicKey);
      });
    });
  });

  describe('deploymentId: latest', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;

    const validWorkflow = Object.assign(() => Promise.resolve('result'), {
      workflowId: 'test-workflow',
    });

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);
      // Reset the warn-once guard so the no-op warn path is exercisable
      // regardless of test order.
      _resetLatestNoOpWarnForTests();
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
      // Restore any spies (e.g. on runtimeLogger.warn) even if a test threw
      // before its own cleanup — clearAllMocks alone doesn't restore spies.
      vi.restoreAllMocks();
    });

    it('should resolve "latest" to the actual deployment ID via resolveLatestDeploymentId', async () => {
      const mockResolveLatest = vi
        .fn()
        .mockResolvedValue('dpl_resolved_abc123');

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
      });

      await start(validWorkflow, [], { deploymentId: 'latest' });

      expect(mockResolveLatest).toHaveBeenCalledTimes(1);

      // The resolved deployment ID should be used in the run_created event
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          eventData: expect.objectContaining({
            deploymentId: 'dpl_resolved_abc123',
          }),
        }),
        expect.anything()
      );

      // The resolved deployment ID should be used in the queue call
      expect(mockQueue).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ deploymentId: 'dpl_resolved_abc123' })
      );
    });

    it('should pass the resolved deployment ID to getEncryptionKeyForRun when using "latest"', async () => {
      const mockResolveLatest = vi
        .fn()
        .mockResolvedValue('dpl_resolved_abc123');
      const mockGetEncryptionKeyForRun = vi.fn();

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
        getEncryptionKeyForRun: mockGetEncryptionKeyForRun,
      });

      await start(validWorkflow, [], { deploymentId: 'latest' });

      expect(mockResolveLatest).toHaveBeenCalledTimes(1);
      expect(mockGetEncryptionKeyForRun).toHaveBeenCalled();

      const [, contextArg] =
        mockGetEncryptionKeyForRun.mock.calls[
          mockGetEncryptionKeyForRun.mock.calls.length - 1
        ] || [];

      expect(contextArg).toEqual(
        expect.objectContaining({
          deploymentId: 'dpl_resolved_abc123',
        })
      );
    });

    it('should warn and fall back to the current deployment ID when "latest" is used with a World that does not implement resolveLatestDeploymentId', async () => {
      const warnSpy = vi
        .spyOn(runtimeLogger, 'warn')
        .mockImplementation(() => {});

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        // No resolveLatestDeploymentId
      });

      // Should not throw — 'latest' is a no-op in worlds without atomic
      // deployments.
      await start(validWorkflow, [], { deploymentId: 'latest' });

      // It should warn that 'latest' had no effect in this world.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("deploymentId: 'latest' has no effect"),
        expect.objectContaining({ currentDeploymentId: 'deploy_123' })
      );

      // The run should fall back to the current deployment ID in both the
      // run_created event and the queue call.
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          eventData: expect.objectContaining({
            deploymentId: 'deploy_123',
          }),
        }),
        expect.anything()
      );
      expect(mockQueue).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ deploymentId: 'deploy_123' })
      );
    });

    it('should only warn once per process when "latest" is used repeatedly in an unsupported World', async () => {
      const warnSpy = vi
        .spyOn(runtimeLogger, 'warn')
        .mockImplementation(() => {});

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        // No resolveLatestDeploymentId
      });

      // Multiple runs that all hit the no-op path...
      await start(validWorkflow, [], { deploymentId: 'latest' });
      await start(validWorkflow, [], { deploymentId: 'latest' });
      await start(validWorkflow, [], { deploymentId: 'latest' });

      // ...should only log the warning a single time.
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // ...but every run still falls back to the current deployment.
      expect(mockQueue).toHaveBeenCalledTimes(3);
      for (const call of mockQueue.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ deploymentId: 'deploy_123' })
        );
      }
    });

    it('should not call resolveLatestDeploymentId when a normal deploymentId is provided', async () => {
      const mockResolveLatest = vi
        .fn()
        .mockResolvedValue('dpl_resolved_abc123');

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
      });

      await start(validWorkflow, [], { deploymentId: 'dpl_specific_456' });

      expect(mockResolveLatest).not.toHaveBeenCalled();

      // The provided deployment ID should be used directly
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventData: expect.objectContaining({
            deploymentId: 'dpl_specific_456',
          }),
        }),
        expect.anything()
      );
    });

    it('should not call resolveLatestDeploymentId when no deploymentId is provided', async () => {
      const mockResolveLatest = vi
        .fn()
        .mockResolvedValue('dpl_resolved_abc123');

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('dpl_default_789'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
      });

      await start(validWorkflow, []);

      expect(mockResolveLatest).not.toHaveBeenCalled();

      // Should use the default from getDeploymentId()
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventData: expect.objectContaining({
            deploymentId: 'dpl_default_789',
          }),
        }),
        expect.anything()
      );
    });
  });

  // A process that is not itself a deployment (e.g. `workflow web` replaying
  // a production run via recreateRunFromExisting, or a recovery script) has
  // no current deployment: the Vercel world's getDeploymentId() throws when
  // VERCEL_DEPLOYMENT_ID is unset.
  describe('without a current deployment', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;
    let mockGetDeploymentId: ReturnType<typeof vi.fn>;

    const validWorkflow = Object.assign(() => Promise.resolve('result'), {
      workflowId: 'test-workflow',
    });

    const createWorld = (overrides: Record<string, unknown> = {}) =>
      ({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: mockGetDeploymentId,
        events: { create: mockEventsCreate },
        queue: mockQueue,
        ...overrides,
      }) as unknown as World;

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);
      mockGetDeploymentId = vi
        .fn()
        .mockRejectedValue(
          new Error('Starting a workflow run requires VERCEL_DEPLOYMENT_ID')
        );
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('starts a run targeted at an explicit deploymentId', async () => {
      const run = await start(validWorkflow, [], {
        deploymentId: 'dpl_target_456',
        world: createWorld(),
      });

      expect(run.runId).toMatch(/^wrun_/);
      expect(mockGetDeploymentId).toHaveBeenCalledTimes(1);
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          eventData: expect.objectContaining({
            deploymentId: 'dpl_target_456',
          }),
        }),
        expect.anything()
      );
      expect(mockQueue).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ deploymentId: 'dpl_target_456' })
      );
    });

    it('treats the explicit deploymentId as a cross-deployment target', async () => {
      // With a probe channel, the start must probe the target's capabilities
      // rather than assume it runs this SDK (the same-deployment shortcut).
      // Failing the probe's enqueue ends it at once instead of polling out
      // its timeout; the start then falls back to the universally readable
      // formats.
      const mockStreamsGet = vi.fn();
      mockQueue.mockImplementation((queueName: string) =>
        queueName.endsWith('health_check')
          ? Promise.reject(new Error('probe unavailable'))
          : Promise.resolve(undefined)
      );

      await start(validWorkflow, [], {
        deploymentId: 'dpl_target_456',
        world: createWorld({ streams: { get: mockStreamsGet } }),
      });

      expect(mockQueue).toHaveBeenCalledWith(
        expect.stringContaining('health_check'),
        expect.anything(),
        expect.objectContaining({ deploymentId: 'dpl_target_456' })
      );
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({ eventType: 'run_created' }),
        expect.anything()
      );
    });

    it('still fails when no deploymentId is given', async () => {
      await expect(
        start(validWorkflow, [], { world: createWorld() })
      ).rejects.toThrow('requires VERCEL_DEPLOYMENT_ID');
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it("still fails for deploymentId: 'latest'", async () => {
      const mockResolveLatest = vi.fn().mockResolvedValue('dpl_latest');

      await expect(
        start(validWorkflow, [], {
          deploymentId: 'latest',
          world: createWorld({ resolveLatestDeploymentId: mockResolveLatest }),
        })
      ).rejects.toThrow('requires VERCEL_DEPLOYMENT_ID');
      expect(mockResolveLatest).not.toHaveBeenCalled();
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });
  });

  describe('resilient start (run_created failure)', () => {
    const validWorkflow = Object.assign(() => Promise.resolve('result'), {
      workflowId: 'test-workflow',
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('should succeed when events.create throws a 500 error (queue still dispatched)', async () => {
      const mockQueue = vi.fn().mockResolvedValue({ messageId: null });
      const serverError = new WorkflowWorldError('Internal Server Error', {
        status: 500,
      });
      const mockEventsCreate = vi.fn().mockRejectedValue(serverError);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      // start() should NOT throw — the queue was still dispatched
      const run = await start(validWorkflow, [42], {
        specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
      });
      expect(run.runId).toMatch(/^wrun_/);

      // Queue should have been called with runInput
      expect(mockQueue).toHaveBeenCalledTimes(1);
      const [, queuePayload] = mockQueue.mock.calls[0];
      expect(queuePayload.runInput).toBeDefined();
      expect(queuePayload.runInput.deploymentId).toBe('deploy_123');
      expect(queuePayload.runInput.workflowName).toBe('test-workflow');
      expect(queuePayload.runInput.specVersion).toBe(
        SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
      );
    });

    it('should throw when queue fails even if events.create succeeds', async () => {
      const mockEventsCreate = vi.fn().mockResolvedValue({
        run: { runId: 'wrun_test', status: 'pending' },
      });
      const mockQueue = vi
        .fn()
        .mockRejectedValue(new Error('Queue unavailable'));

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(start(validWorkflow, [])).rejects.toThrow(
        'Queue unavailable'
      );
    });

    it('should throw when events.create fails with a non-retryable error (e.g. 400)', async () => {
      const badRequest = new WorkflowWorldError('Bad Request', {
        status: 400,
      });
      const mockEventsCreate = vi.fn().mockRejectedValue(badRequest);
      const mockQueue = vi.fn().mockResolvedValue({ messageId: null });

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(start(validWorkflow, [])).rejects.toThrow('Bad Request');
    });
  });

  describe('replay lineage (executionContext.replayedFromRunId)', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;

    const validWorkflow = Object.assign(() => Promise.resolve('result'), {
      workflowId: 'test-workflow',
    });

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('records replayedFromRunId in executionContext when provided', async () => {
      const sourceRunId = 'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV';
      await start(validWorkflow, [], { replayedFromRunId: sourceRunId });

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          eventData: expect.objectContaining({
            executionContext: expect.objectContaining({
              replayedFromRunId: sourceRunId,
            }),
          }),
        }),
        expect.anything()
      );
    });

    it('records the current Node.js version for a same-deployment start', async () => {
      await start(validWorkflow, []);

      const eventData = mockEventsCreate.mock.calls[0]?.[1]?.eventData;
      expect(eventData.executionContext.nodeVersion).toBe(
        process.versions.node
      );
    });

    it('omits replayedFromRunId from executionContext when not provided', async () => {
      await start(validWorkflow, []);

      const eventData = mockEventsCreate.mock.calls[0]?.[1]?.eventData;
      expect(eventData.executionContext).not.toHaveProperty(
        'replayedFromRunId'
      );
    });

    it('rejects a replayedFromRunId without the wrun_ prefix', async () => {
      await expect(
        start(validWorkflow, [], { replayedFromRunId: 'not-a-run-id' })
      ).rejects.toThrow(/replayedFromRunId must be a run ID/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it('rejects a wrun_-prefixed value whose body is not a valid ULID', async () => {
      await expect(
        start(validWorkflow, [], {
          replayedFromRunId: `wrun_${'x'.repeat(300)}`,
        })
      ).rejects.toThrow(/replayedFromRunId must be a run ID/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it('rejects a non-string replayedFromRunId', async () => {
      await expect(
        start(validWorkflow, [], {
          // Types forbid this, but JS callers can still pass it.
          replayedFromRunId: 12345 as unknown as string,
        })
      ).rejects.toThrow(/replayedFromRunId must be a run ID/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });
  });

  describe('overload type inference', () => {
    // Type-only assertions that don't execute start() at runtime.
    // We use expectTypeOf on the function signature's return type directly.

    type TypedWf = WorkflowFunction<[string, number], boolean>;
    type ZeroArgWf = WorkflowFunction<[], string>;
    type Meta = { workflowId: string };

    it('should preserve types without deploymentId', () => {
      // With args
      expectTypeOf<
        (wf: TypedWf, args: [string, number]) => Promise<Run<boolean>>
      >().toMatchTypeOf<typeof start>();

      // Zero-arg workflow without args
      expectTypeOf(start<string>)
        .parameter(0)
        .toMatchTypeOf<ZeroArgWf | Meta>();
    });

    it('should return Run<unknown> when deploymentId is provided', () => {
      // Typed workflow with deploymentId - return type becomes Run<unknown>
      type StartWithDeploymentId = (
        wf: TypedWf | Meta,
        args: unknown[],
        opts: { deploymentId: string }
      ) => Promise<Run<unknown>>;
      expectTypeOf<StartWithDeploymentId>().toMatchTypeOf<typeof start>();
    });

    it('should accept typed workflows with deploymentId (no contravariance issue)', () => {
      // This is the key test: a typed workflow should be assignable to the
      // deploymentId overload. We verify by checking the first parameter
      // accepts TypedWf.
      type DeploymentIdOverload = <TArgs extends unknown[], TResult>(
        wf: WorkflowFunction<TArgs, TResult> | Meta,
        args: unknown[],
        opts: { deploymentId: string }
      ) => Promise<Run<unknown>>;
      expectTypeOf<DeploymentIdOverload>().toMatchTypeOf<typeof start>();
    });
  });
  describe('createRunId', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('uses world.createRunId() when provided', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      const customId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const createRunId = vi.fn().mockReturnValue(customId);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        createRunId,
      } as any);

      await start(validWorkflow, []);

      expect(createRunId).toHaveBeenCalledTimes(1);
      // No options were passed, so the world receives an empty object
      // (the default value used internally).
      expect(createRunId).toHaveBeenCalledWith({});
      expect(mockEventsCreate).toHaveBeenCalledWith(
        `wrun_${customId}`,
        expect.objectContaining({ eventType: 'run_created' }),
        expect.any(Object)
      );
    });

    it('passes the full options bag through to world.createRunId()', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      const customId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const createRunId = vi.fn().mockReturnValue(customId);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        createRunId,
      } as any);

      await start(validWorkflow, [], {
        region: 'fra1',
        specVersion: 3,
      });

      expect(createRunId).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'fra1', specVersion: 3 })
      );
    });

    it('threads opts.region onto queue opts', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      const customId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        createRunId: vi.fn().mockReturnValue(customId),
      } as any);

      await start(validWorkflow, [], { region: 'fra1' });

      expect(mockQueue).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ runId: `wrun_${customId}` }),
        expect.objectContaining({ region: 'fra1' })
      );
    });

    it('omits region from queue opts when opts.region is undefined', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        createRunId: vi.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
      } as any);

      await start(validWorkflow, []);

      const queueOpts = mockQueue.mock.calls[0][2];
      expect(queueOpts).not.toHaveProperty('region');
    });

    it('falls back to a default monotonic ULID when world.createRunId is omitted', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await start(validWorkflow, []);

      // ULIDs are 26 Crockford-Base32 chars; the runId becomes
      // `wrun_` + 26 chars = 31 chars total.
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_[0-9A-HJKMNP-TV-Z]{26}$/),
        expect.objectContaining({ eventType: 'run_created' }),
        expect.any(Object)
      );
    });
  });

  describe('queue namespace', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;

    const validWorkflow = Object.assign(() => Promise.resolve('result'), {
      workflowId: 'test-workflow',
    });

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('enqueues to the default topic when no namespace is provided', async () => {
      await start(validWorkflow, []);

      expect(mockQueue).toHaveBeenCalledWith(
        '__wkf_workflow_test-workflow',
        expect.anything(),
        expect.anything()
      );
    });

    it('enqueues to the namespaced topic when a namespace is provided', async () => {
      await start(validWorkflow, [], { namespace: 'eve' });

      expect(mockQueue).toHaveBeenCalledWith(
        '__eve_wkf_workflow_test-workflow',
        expect.anything(),
        expect.anything()
      );
    });

    it('records the namespace on the run so recovery re-enqueues it there', async () => {
      await start(validWorkflow, [], { namespace: 'eve' });
      const created = mockEventsCreate.mock.calls.find(
        ([, event]) => event.eventType === 'run_created'
      );
      expect(created?.[1].eventData.executionContext).toMatchObject({
        queueNamespace: 'eve',
      });
    });

    it('records no namespace for the default topic', async () => {
      vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', undefined);
      try {
        await start(validWorkflow, []);
      } finally {
        vi.unstubAllEnvs();
      }
      const created = mockEventsCreate.mock.calls.find(
        ([, event]) => event.eventType === 'run_created'
      );
      expect(created?.[1].eventData.executionContext).not.toHaveProperty(
        'queueNamespace'
      );
    });

    it('probes the namespaced health-check topic on cross-deployment starts', async () => {
      // Cross-deployment starts (explicit deploymentId different from the
      // current one) run a capability probe before enqueueing. The probe
      // must target the same namespaced topic family as the run itself —
      // otherwise deployments using a queue namespace never see it.
      const healthResponse = JSON.stringify({
        healthy: true,
        endpoint: 'workflow',
        specVersion: SPEC_VERSION_CURRENT,
        workflowCoreVersion: '0.0.0-test',
      });

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        streams: {
          get: vi.fn(
            async () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(healthResponse));
                  controller.close();
                },
              })
          ),
        },
      });

      await start(validWorkflow, [], {
        deploymentId: 'dpl_other',
        namespace: 'eve',
      });

      expect(mockQueue).toHaveBeenCalledWith(
        '__eve_wkf_workflow_health_check',
        expect.objectContaining({ __healthCheck: true }),
        expect.objectContaining({ deploymentId: 'dpl_other' })
      );
      expect(mockQueue).toHaveBeenCalledWith(
        '__eve_wkf_workflow_test-workflow',
        expect.anything(),
        expect.objectContaining({ deploymentId: 'dpl_other' })
      );
    });

    describe('run public key from the capability probe', () => {
      const MATERIAL = new Uint8Array(32).fill(0x8c);

      /** A world whose probe responds with the given extra fields. */
      function worldWithProbe(
        extra: Record<string, unknown>,
        getEncryptionKeyForRun?: ReturnType<typeof vi.fn>
      ) {
        const response = JSON.stringify({
          healthy: true,
          endpoint: 'workflow',
          specVersion: SPEC_VERSION_CURRENT,
          workflowCoreVersion: '0.0.0-test',
          ...extra,
        });
        setWorld({
          specVersion: SPEC_VERSION_CURRENT,
          getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
          events: { create: mockEventsCreate },
          queue: mockQueue,
          getEncryptionKeyForRun,
          streams: {
            get: vi.fn(
              async () =>
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode(response));
                    controller.close();
                  },
                })
            ),
          },
        });
      }

      it('asks the probe for the run it is about to create', async () => {
        // The runId has to be minted before the probe for this to work, so
        // this also guards the ordering.
        worldWithProbe({});

        await start(validWorkflow, [], { deploymentId: 'dpl_other' });

        const probeCall = mockQueue.mock.calls.find((c) =>
          String(c[0]).endsWith('health_check')
        );
        expect(probeCall?.[1]).toMatchObject({
          __healthCheck: true,
          probeRunId: expect.stringMatching(/^wrun_/),
        });
        // ...and it is the same run that actually gets created.
        expect(probeCall?.[1].probeRunId).toBe(
          mockEventsCreate.mock.calls[0][0]
        );
      });

      it('sends a probe that a 4.x deployment cannot mistake for a run invocation', async () => {
        // 4.x deployments parse queue payloads with a union that tries the
        // invoke schema first. A probe that satisfies it is replayed as a run
        // that doesn't exist yet (run_started 404, redelivered), so the probe
        // never answers and every cross-deployment start() to a 4.x target
        // waits out the full probe budget.
        worldWithProbe({});

        await start(validWorkflow, [], { deploymentId: 'dpl_other' });

        const probeCall = mockQueue.mock.calls.find((c) =>
          String(c[0]).endsWith('health_check')
        );
        expect(probeCall).toBeDefined();
        expect(
          WorkflowInvokePayloadSchema.safeParse(probeCall?.[1]).success
        ).toBe(false);
      });

      it('seals the arguments with the probed key and skips the key lookup', async () => {
        const { publicKey } = await deriveRunKeyPair(MATERIAL);
        const getEncryptionKeyForRun = vi.fn().mockResolvedValue(MATERIAL);
        worldWithProbe(
          { encryptionPublicKey: bytesToBase64(publicKey) },
          getEncryptionKeyForRun
        );

        await start(validWorkflow, ['hello'], { deploymentId: 'dpl_other' });

        // The whole point: no key-lookup request on this path.
        expect(getEncryptionKeyForRun).not.toHaveBeenCalled();

        const eventData = mockEventsCreate.mock.calls[0][1].eventData;
        expect(peekFormatPrefix(eventData.input)).toBe(
          SerializationFormat.SEALED
        );
        // The run still advertises the key so later cross-run writers can
        // seal to it too.
        expect(eventData.encryptionPublicKey).toBe(bytesToBase64(publicKey));
      });

      it('produces arguments the target deployment can actually open', async () => {
        const keyPair = await deriveRunKeyPair(MATERIAL);
        worldWithProbe({
          encryptionPublicKey: bytesToBase64(keyPair.publicKey),
        });

        await start(validWorkflow, ['hello', 42], {
          deploymentId: 'dpl_other',
        });

        const { input } = mockEventsCreate.mock.calls[0][1].eventData;
        const keys = runPayloadKeys(await importKey(MATERIAL), keyPair);
        await expect(
          hydrateWorkflowArguments(input, 'wrun_x', keys)
        ).resolves.toEqual(['hello', 42]);
      });

      it('stamps the probed Node.js version and writes a codec it decodes', async () => {
        const bigArg = 'argument '.repeat(500);
        worldWithProbe({
          workflowCoreVersion: '5.0.0',
          nodeVersion: '20.19.0',
        });

        await start(validWorkflow, [bigArg], { deploymentId: 'dpl_other' });

        const eventData = mockEventsCreate.mock.calls[0][1].eventData;
        // The target's version, not the caller's, so later hook resumes know
        // what the run's runtime can decode.
        expect(eventData.executionContext.nodeVersion).toBe('20.19.0');
        expect(peekFormatPrefix(eventData.input)).toBe(
          SerializationFormat.GZIP
        );
      });

      it('omits nodeVersion when the probe does not report one', async () => {
        worldWithProbe({ workflowCoreVersion: '5.0.0' });

        await start(validWorkflow, ['argument '.repeat(500)], {
          deploymentId: 'dpl_other',
        });

        const eventData = mockEventsCreate.mock.calls[0][1].eventData;
        expect(eventData.executionContext).not.toHaveProperty('nodeVersion');
        expect(peekFormatPrefix(eventData.input)).toBe(
          SerializationFormat.GZIP
        );
      });

      it('falls back to the key lookup when the probe returns no key', async () => {
        // Older target deployment, or a probe that timed out.
        const getEncryptionKeyForRun = vi.fn().mockResolvedValue(MATERIAL);
        worldWithProbe({}, getEncryptionKeyForRun);

        await start(validWorkflow, [], { deploymentId: 'dpl_other' });

        expect(getEncryptionKeyForRun).toHaveBeenCalled();
        expect(
          peekFormatPrefix(mockEventsCreate.mock.calls[0][1].eventData.input)
        ).toBe(SerializationFormat.ENCRYPTED);
      });

      it('ignores a malformed probed key and falls back', async () => {
        const getEncryptionKeyForRun = vi.fn().mockResolvedValue(MATERIAL);
        worldWithProbe(
          { encryptionPublicKey: 'not-a-valid-key' },
          getEncryptionKeyForRun
        );

        await start(validWorkflow, [], { deploymentId: 'dpl_other' });

        expect(getEncryptionKeyForRun).toHaveBeenCalled();
        expect(
          peekFormatPrefix(mockEventsCreate.mock.calls[0][1].eventData.input)
        ).toBe(SerializationFormat.ENCRYPTED);
      });
    });
  });

  describe('idempotency keys', () => {
    const KEY = 'order-1';
    const keyedWorkflow = Object.assign(
      (..._args: unknown[]) => Promise.resolve('result'),
      { workflowId: 'keyed-workflow' }
    );
    const HOLDER = 'wrun_01JA0000000000000000000HXD';

    let eventsCreate: ReturnType<typeof vi.fn>;
    let queue: ReturnType<typeof vi.fn>;
    let runsGet: ReturnType<typeof vi.fn>;
    let getDeploymentId: ReturnType<typeof vi.fn>;

    function keyedWorld(overrides: Record<string, unknown> = {}) {
      const world = {
        specVersion: SPEC_VERSION_CURRENT,
        capabilities: { runIdempotencyKeys: true },
        getDeploymentId,
        events: { create: eventsCreate },
        runs: { get: runsGet },
        queue,
        ...overrides,
      } as any;
      setWorld(world);
      return world;
    }

    /** Resolve run_created the way a keyed World does: echoing the key. */
    function echoKey() {
      eventsCreate.mockImplementation(async (runId, event) => ({
        run: {
          runId,
          status: 'pending',
          idempotencyKey: event.eventData.idempotencyKey,
        },
      }));
    }

    const refusal = (runStatus: string) =>
      new WorkflowRunAlreadyStartedError(HOLDER, {
        runStatus,
        workflowName: 'keyed-workflow',
      });

    beforeEach(() => {
      eventsCreate = vi.fn();
      queue = vi.fn().mockResolvedValue({ messageId: null });
      runsGet = vi.fn();
      getDeploymentId = vi.fn().mockResolvedValue('deploy_123');
      echoKey();
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
      vi.restoreAllMocks();
    });

    it('sends the key with its resolved defaults on run_created', async () => {
      keyedWorld();
      await start(keyedWorkflow, [1], { experimental_idempotencyKey: KEY });

      expect(eventsCreate.mock.calls[0][1].eventData).toMatchObject({
        idempotencyKey: KEY,
        idempotencyKeyTtlMs: 86_400_000,
        idempotencyKeyReusePolicy: 'REJECT_DUPLICATE',
      });
      // The conflict policy is applied by the runtime, never sent.
      expect(eventsCreate.mock.calls[0][1].eventData).not.toHaveProperty(
        'idempotencyKeyConflictPolicy'
      );
    });

    it('sends the caller TTL and reuse policy', async () => {
      keyedWorld();
      await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
        experimental_idempotencyKeyTTL: '2h',
        experimental_idempotencyKeyReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
      });
      expect(eventsCreate.mock.calls[0][1].eventData).toMatchObject({
        idempotencyKeyTtlMs: 7_200_000,
        idempotencyKeyReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
      });
    });

    it('does not publish until run_created has resolved', async () => {
      keyedWorld();
      let resolveCreate!: (value: unknown) => void;
      eventsCreate.mockImplementation(
        (runId, event) =>
          new Promise((resolve) => {
            resolveCreate = () =>
              resolve({
                run: {
                  runId,
                  status: 'pending',
                  idempotencyKey: event.eventData.idempotencyKey,
                },
              });
          })
      );

      const pending = start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
      });
      await vi.waitFor(() => expect(eventsCreate).toHaveBeenCalledOnce());
      // Give any parallel publish every chance to happen.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(queue).not.toHaveBeenCalled();

      resolveCreate(undefined);
      const run = await pending;
      expect(queue).toHaveBeenCalledOnce();
      expect(run.experimental_started).toBe(true);
    });

    it('publishes a created run with its runInput and a start queue key', async () => {
      keyedWorld();
      const run = await start(keyedWorkflow, [42], {
        experimental_idempotencyKey: KEY,
      });

      expect(run).toBeInstanceOf(Run);
      expect(run.experimental_started).toBe(true);
      const runId = eventsCreate.mock.calls[0][0];
      expect(run.runId).toBe(runId);
      expect(queue).toHaveBeenCalledOnce();
      const [queueName, payload, queueOpts] = queue.mock.calls[0];
      expect(queueName).toBe(getWorkflowQueueName('keyed-workflow'));
      expect(payload.runId).toBe(runId);
      expect(payload.runInput).toMatchObject({
        deploymentId: 'deploy_123',
        workflowName: 'keyed-workflow',
      });
      // A resilient run_started never carries the key.
      expect(JSON.stringify(Object.keys(payload.runInput))).not.toMatch(
        /idempotency/i
      );
      expect(queueOpts).toMatchObject({
        deploymentId: 'deploy_123',
        idempotencyKey: `start-${runId}`,
      });
      expect(runsGet).not.toHaveBeenCalled();
    });

    it('publishes and reports started when its own earlier write already landed', async () => {
      keyedWorld();
      eventsCreate.mockRejectedValue(
        new EntityConflictError('Workflow run already exists')
      );

      const run = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
      });

      const runId = eventsCreate.mock.calls[0][0];
      expect(run.runId).toBe(runId);
      expect(run.experimental_started).toBe(true);
      expect(queue).toHaveBeenCalledOnce();
      expect(queue.mock.calls[0][1].runInput).toBeDefined();
      expect(queue.mock.calls[0][2]).toMatchObject({
        idempotencyKey: `start-${runId}`,
      });
    });

    it('returns a pending holder and re-publishes its initial message', async () => {
      keyedWorld();
      eventsCreate.mockRejectedValue(refusal('pending'));
      runsGet.mockResolvedValue({
        runId: HOLDER,
        status: 'pending',
        workflowName: 'holder-workflow',
        deploymentId: 'dpl_holder',
        specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
        executionContext: { queueNamespace: 'eve' },
      });

      const run = await start(keyedWorkflow, [1], {
        experimental_idempotencyKey: KEY,
      });

      expect(run).toBeInstanceOf(Run);
      expect(run.runId).toBe(HOLDER);
      expect(run.experimental_started).toBe(false);
      expect(runsGet).toHaveBeenCalledWith(HOLDER, { resolveData: 'none' });
      expect(queue).toHaveBeenCalledOnce();
      expect(queue).toHaveBeenCalledWith(
        getWorkflowQueueName('holder-workflow', 'eve'),
        { runId: HOLDER, traceCarrier: {} },
        {
          deploymentId: 'dpl_holder',
          specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
          idempotencyKey: `start-${HOLDER}`,
        }
      );
    });

    it('throws when re-publishing a pending holder fails', async () => {
      keyedWorld();
      eventsCreate.mockRejectedValue(refusal('pending'));
      runsGet.mockResolvedValue({
        runId: HOLDER,
        status: 'pending',
        workflowName: 'holder-workflow',
        deploymentId: 'dpl_holder',
        specVersion: SPEC_VERSION_CURRENT,
      });
      queue.mockRejectedValue(new Error('Queue unavailable'));

      await expect(
        start(keyedWorkflow, [], { experimental_idempotencyKey: KEY })
      ).rejects.toThrow('Queue unavailable');
    });

    it.each([
      'running',
      'completed',
      'failed',
      'cancelled',
    ])('returns a %s holder without publishing anything', async (status) => {
      keyedWorld();
      eventsCreate.mockRejectedValue(refusal(status));

      const run = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
      });

      expect(run.runId).toBe(HOLDER);
      expect(run.experimental_started).toBe(false);
      expect(queue).not.toHaveBeenCalled();
      expect(runsGet).not.toHaveBeenCalled();
    });

    it('rethrows the refusal under the FAIL conflict policy', async () => {
      keyedWorld();
      const error = refusal('running');
      eventsCreate.mockRejectedValue(error);

      const thrown = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
        experimental_idempotencyKeyConflictPolicy: 'FAIL',
      }).catch((err: unknown) => err);

      expect(thrown).toBe(error);
      expect(WorkflowRunAlreadyStartedError.is(thrown)).toBe(true);
      expect(thrown).toMatchObject({
        runId: HOLDER,
        runStatus: 'running',
        idempotencyKey: KEY,
      });
      expect(queue).not.toHaveBeenCalled();
      expect(runsGet).not.toHaveBeenCalled();
    });

    const pendingHolder = {
      runId: HOLDER,
      status: 'pending',
      workflowName: 'holder-workflow',
      deploymentId: 'dpl_holder',
      specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
      executionContext: {},
    };

    it('still publishes an unkeyed start while run_created is unresolved', async () => {
      keyedWorld();
      let resolveCreate!: () => void;
      eventsCreate.mockImplementation(
        (runId) =>
          new Promise((resolve) => {
            resolveCreate = () =>
              resolve({ run: { runId, status: 'pending' } });
          })
      );

      const pending = start(keyedWorkflow, []);
      // The unkeyed publish runs beside the write, not after it.
      await vi.waitFor(() => expect(queue).toHaveBeenCalledOnce());
      expect(eventsCreate).toHaveBeenCalledOnce();
      resolveCreate();
      const run = await pending;
      expect(run.experimental_started).toBe(true);
    });

    describe('stream arguments', () => {
      /** A one-shot source that records whether it was ever read. */
      function oneShotSource() {
        const reads = { count: 0 };
        // No queue to pre-fill (highWaterMark 0), so `pull` runs only when
        // a consumer actually reads.
        const stream = new ReadableStream<string>(
          {
            pull(controller) {
              reads.count++;
              controller.enqueue('webhook body');
              controller.close();
            },
          },
          { highWaterMark: 0 }
        );
        return { stream, reads };
      }

      function streamWorld() {
        const streams = {
          write: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        };
        keyedWorld({ streams });
        return streams;
      }

      it.each([
        ['USE_EXISTING', 'running'],
        ['USE_EXISTING', 'pending'],
        ['FAIL', 'running'],
      ] as const)('never reads a refused duplicate start stream argument (%s, %s holder)', async (conflictPolicy, status) => {
        const streams = streamWorld();
        eventsCreate.mockRejectedValue(refusal(status));
        runsGet.mockResolvedValue({
          runId: HOLDER,
          status,
          workflowName: 'keyed-workflow',
          deploymentId: 'deploy_123',
          specVersion: SPEC_VERSION_CURRENT,
          executionContext: {},
        });
        const { stream, reads } = oneShotSource();

        await start(keyedWorkflow, [stream], {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyConflictPolicy: conflictPolicy,
        }).catch(() => {});
        // Give any pipe that wrongly started time to pull.
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(reads.count).toBe(0);
        // Untouched: the caller can still read it.
        expect(stream.locked).toBe(false);
        expect(streams.write).not.toHaveBeenCalled();
        expect(streams.close).not.toHaveBeenCalled();
      });

      it('never opens the readback into a refused duplicate start writable argument', async () => {
        const streams = streamWorld();
        const streamsGet = vi.fn();
        keyedWorld({ streams: { ...streams, get: streamsGet } });
        eventsCreate.mockRejectedValue(refusal('running'));
        const sink = new WritableStream<string>();

        await start(keyedWorkflow, [sink], {
          experimental_idempotencyKey: KEY,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(sink.locked).toBe(false);
        expect(streamsGet).not.toHaveBeenCalled();
      });

      it('never reads a stream argument when run_created fails', async () => {
        const streams = streamWorld();
        eventsCreate.mockRejectedValue(
          new WorkflowWorldError('Internal Server Error', { status: 500 })
        );
        const { stream, reads } = oneShotSource();

        await expect(
          start(keyedWorkflow, [stream], { experimental_idempotencyKey: KEY })
        ).rejects.toThrow('Internal Server Error');
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(reads.count).toBe(0);
        expect(stream.locked).toBe(false);
        expect(streams.write).not.toHaveBeenCalled();
      });

      it('does not read the stream before run_created resolves, and pipes it once the run is created', async () => {
        const streams = streamWorld();
        let resolveCreate!: () => void;
        eventsCreate.mockImplementation(
          (runId, event) =>
            new Promise((resolve) => {
              resolveCreate = () =>
                resolve({
                  run: {
                    runId,
                    status: 'pending',
                    idempotencyKey: event.eventData.idempotencyKey,
                  },
                });
            })
        );
        const { stream, reads } = oneShotSource();

        const pending = start(keyedWorkflow, [stream], {
          experimental_idempotencyKey: KEY,
        });
        await vi.waitFor(() => expect(eventsCreate).toHaveBeenCalledOnce());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(reads.count).toBe(0);

        resolveCreate();
        const run = await pending;
        expect(run.experimental_started).toBe(true);
        await vi.waitFor(() => expect(reads.count).toBe(1));
        await vi.waitFor(() => expect(streams.close).toHaveBeenCalled());
        expect(streams.write).toHaveBeenCalledWith(
          run.runId,
          expect.stringMatching(/^strm_/),
          expect.anything()
        );
      });

      it('pipes the stream on a self-conflict, whose run exists', async () => {
        const streams = streamWorld();
        eventsCreate.mockRejectedValue(
          new EntityConflictError('Workflow run already exists')
        );
        const { stream, reads } = oneShotSource();

        await start(keyedWorkflow, [stream], {
          experimental_idempotencyKey: KEY,
        });

        await vi.waitFor(() => expect(reads.count).toBe(1));
        await vi.waitFor(() => expect(streams.close).toHaveBeenCalled());
      });

      it('still pipes an unkeyed start stream immediately, beside run_created', async () => {
        const streams = streamWorld();
        eventsCreate.mockImplementation(() => new Promise(() => {}));
        const { stream, reads } = oneShotSource();

        void start(keyedWorkflow, [stream]);

        await vi.waitFor(() => expect(reads.count).toBe(1));
        await vi.waitFor(() => expect(streams.close).toHaveBeenCalled());
      });
    });

    it('re-publishes a pending holder before rethrowing under FAIL', async () => {
      keyedWorld();
      const error = refusal('pending');
      eventsCreate.mockRejectedValue(error);
      runsGet.mockResolvedValue(pendingHolder);

      const thrown = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
        experimental_idempotencyKeyConflictPolicy: 'FAIL',
      }).catch((err: unknown) => err);

      expect(thrown).toBe(error);
      expect(runsGet).toHaveBeenCalledWith(HOLDER, { resolveData: 'none' });
      expect(queue).toHaveBeenCalledOnce();
      expect(queue.mock.calls[0][0]).toBe(
        getWorkflowQueueName('holder-workflow')
      );
      expect(queue.mock.calls[0][1]).toMatchObject({ runId: HOLDER });
      expect(queue.mock.calls[0][2]).toMatchObject({
        deploymentId: 'dpl_holder',
        idempotencyKey: `start-${HOLDER}`,
      });
    });

    it('throws the re-publish failure under FAIL so the caller retries', async () => {
      keyedWorld();
      eventsCreate.mockRejectedValue(refusal('pending'));
      runsGet.mockResolvedValue(pendingHolder);
      const publishError = new WorkflowWorldError('queue down', {
        status: 503,
      });
      queue.mockRejectedValue(publishError);

      await expect(
        start(keyedWorkflow, [], {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyConflictPolicy: 'FAIL',
        })
      ).rejects.toBe(publishError);
    });

    it.each([
      ['USE_EXISTING', 'pending', 1],
      ['USE_EXISTING', 'running', 0],
      ['FAIL', 'pending', 1],
      ['FAIL', 'completed', 0],
    ] as const)('reads the holder status when the refusal omits it (%s, %s)', async (conflictPolicy, status, publishes) => {
      keyedWorld();
      const error = new WorkflowRunAlreadyStartedError(HOLDER);
      eventsCreate.mockRejectedValue(error);
      runsGet.mockResolvedValue({ ...pendingHolder, status });

      const result = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
        experimental_idempotencyKeyConflictPolicy: conflictPolicy,
      }).catch((err: unknown) => err);

      expect(runsGet).toHaveBeenCalledOnce();
      expect(queue).toHaveBeenCalledTimes(publishes);
      if (conflictPolicy === 'FAIL') {
        expect(result).toBe(error);
        expect(error.runStatus).toBe(status);
      } else {
        expect(result).toBeInstanceOf(Run);
        expect((result as Run<unknown>).runId).toBe(HOLDER);
      }
    });

    it.each([
      ['USE_EXISTING'],
      ['FAIL'],
    ] as const)('refuses, fatally, a refusal that names no valid holder (%s)', async (conflictPolicy) => {
      keyedWorld();
      const error = new WorkflowRunAlreadyStartedError('unknown', {
        runStatus: 'pending',
      });
      eventsCreate.mockRejectedValue(error);

      const thrown = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
        experimental_idempotencyKeyConflictPolicy: conflictPolicy,
      }).catch((err: unknown) => err);

      expect(thrown).not.toBeInstanceOf(Run);
      expect(WorkflowRuntimeError.is(thrown)).toBe(true);
      expect(FatalError.is(thrown)).toBe(true);
      expect((thrown as Error).message).toMatch(
        /did not name a valid run holding the key \(received "unknown"\)/
      );
      expect((thrown as Error).cause).toBe(error);
      expect(runsGet).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    it('makes the backend kill switch fatal and publishes nothing', async () => {
      keyedWorld();
      const disabled = new WorkflowWorldError(
        'Run idempotency keys are disabled on this Workflow backend.',
        { status: 400, code: 'idempotency-keys-disabled' }
      );
      eventsCreate.mockRejectedValue(disabled);

      const thrown = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
      }).catch((err: unknown) => err);

      expect(thrown).toBe(disabled);
      expect(FatalError.is(thrown)).toBe(true);
      expect(isRetryableWorldError(thrown)).toBe(false);
      expect(thrown).toMatchObject({
        status: 400,
        code: 'idempotency-keys-disabled',
      });
      expect(queue).not.toHaveBeenCalled();
    });

    it('does not mark other run_created failures fatal', async () => {
      keyedWorld();
      const transient = new WorkflowWorldError('Internal Server Error', {
        status: 500,
      });
      eventsCreate.mockRejectedValue(transient);

      const thrown = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
      }).catch((err: unknown) => err);
      expect(thrown).toBe(transient);
      expect(FatalError.is(thrown)).toBe(false);
    });

    it.each<[string, Record<string, unknown>, RegExp]>([
      ['an empty key', { experimental_idempotencyKey: '' }, /1 to 256/],
      [
        'a lone surrogate',
        { experimental_idempotencyKey: 'order-\uD800' },
        /lone surrogate/,
      ],
      [
        'an orphan option',
        { experimental_idempotencyKeyTTL: '1h' },
        /requires experimental_idempotencyKey/,
      ],
      [
        'a TTL out of range',
        { experimental_idempotencyKey: KEY, experimental_idempotencyKeyTTL: 1 },
        /experimental_idempotencyKeyTTL/,
      ],
      [
        'an unknown policy',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyReusePolicy: 'NOPE',
        },
        /experimental_idempotencyKeyReusePolicy/,
      ],
      [
        'an explicit legacy spec version',
        { experimental_idempotencyKey: KEY, specVersion: 1 },
        /requires spec version 2 or later.*spec version 1/,
      ],
    ])('refuses %s fatally, before any I/O', async (_label, options, message) => {
      const world = keyedWorld({
        createRunId: vi.fn(),
        getEncryptionKeyForRun: vi.fn(),
        streams: { get: vi.fn() },
      });

      const thrown = await start(keyedWorkflow, [], options as never).catch(
        (err: unknown) => err
      );

      expect(WorkflowRuntimeError.is(thrown)).toBe(true);
      expect(FatalError.is(thrown)).toBe(true);
      expect((thrown as Error).message).toMatch(message);
      expect(getDeploymentId).not.toHaveBeenCalled();
      expect(world.createRunId).not.toHaveBeenCalled();
      expect(world.streams.get).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    it('refuses a keyed start whose target deployment resolves to a legacy spec version', async () => {
      const healthResponse = JSON.stringify({
        healthy: true,
        endpoint: 'workflow',
        specVersion: 1,
        workflowCoreVersion: '0.0.0-test',
      });
      const streamsGet = vi.fn(
        async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(healthResponse));
              controller.close();
            },
          })
      );
      keyedWorld({ streams: { get: streamsGet } });

      const thrown = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
        deploymentId: 'dpl_old',
      }).catch((err: unknown) => err);

      expect(FatalError.is(thrown)).toBe(true);
      expect((thrown as Error).message).toMatch(/spec version 1/);
      expect(eventsCreate).not.toHaveBeenCalled();
    });

    it('fails closed on a World without the capability with no I/O at all', async () => {
      const streamsGet = vi.fn();
      const uploadDynamicWorkflowCode = vi.fn();
      keyedWorld({
        capabilities: { dynamicWorkflowCode: true },
        streams: { get: streamsGet },
        uploadDynamicWorkflowCode,
      });

      const thrown = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
        deploymentId: 'dpl_other',
      }).catch((err: unknown) => err);

      expect(FatalError.is(thrown)).toBe(true);
      expect((thrown as Error).message).toMatch(
        /capabilities\.runIdempotencyKeys/
      );
      expect(getDeploymentId).not.toHaveBeenCalled();
      expect(streamsGet).not.toHaveBeenCalled();
      expect(uploadDynamicWorkflowCode).not.toHaveBeenCalled();
      expect(runsGet).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    it('keeps argument streams alive only for a run that was created', async () => {
      const { waitUntil } = await import('@vercel/functions');
      keyedWorld();
      await start(keyedWorkflow, [], { experimental_idempotencyKey: KEY });
      const createdCalls = vi.mocked(waitUntil).mock.calls.length;

      vi.mocked(waitUntil).mockClear();
      eventsCreate.mockRejectedValue(refusal('running'));
      await start(keyedWorkflow, [], { experimental_idempotencyKey: KEY });
      const refusedCalls = vi.mocked(waitUntil).mock.calls.length;

      // The created start also hands its argument-stream flush to
      // waitUntil; the refused one does not.
      expect(refusedCalls).toBe(createdCalls - 1);
    });

    it('publishes a keyed cross-deployment start to the target deployment after run_created', async () => {
      const healthResponse = JSON.stringify({
        healthy: true,
        endpoint: 'workflow',
        specVersion: SPEC_VERSION_CURRENT,
        workflowCoreVersion: '0.0.0-test',
      });
      keyedWorld({
        streams: {
          get: vi.fn(
            async () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(healthResponse));
                  controller.close();
                },
              })
          ),
        },
      });

      const run = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
        deploymentId: 'dpl_other',
      });

      expect(run.experimental_started).toBe(true);
      expect(eventsCreate.mock.calls[0][1].eventData).toMatchObject({
        deploymentId: 'dpl_other',
        idempotencyKey: KEY,
      });
      const runPublish = queue.mock.calls.findIndex(
        (call) => call[1]?.runId === run.runId
      );
      expect(runPublish).toBeGreaterThanOrEqual(0);
      expect(queue.mock.calls[runPublish][2]).toMatchObject({
        deploymentId: 'dpl_other',
        idempotencyKey: `start-${run.runId}`,
      });
      expect(queue.mock.invocationCallOrder[runPublish]).toBeGreaterThan(
        eventsCreate.mock.invocationCallOrder[0]
      );
    });

    describe('with dynamic source', () => {
      const source = 'async function workflow() { "use workflow"; return 1; }';
      const dynamic = { steps: { noop: { stepId: 'step//./test//noop' } } };

      beforeEach(() => {
        vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, '1');
      });
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      function dynamicKeyedWorld() {
        return keyedWorld({
          capabilities: { runIdempotencyKeys: true, dynamicWorkflowCode: true },
          getEncryptionKeyForRun: vi.fn(),
          uploadDynamicWorkflowCode: vi.fn(),
        });
      }

      it('creates, then publishes, a keyed dynamic run', async () => {
        dynamicKeyedWorld();
        eventsCreate.mockImplementation(async (runId, event) => ({
          run: {
            runId,
            status: 'pending',
            idempotencyKey: event.eventData.idempotencyKey,
            dynamicWorkflowCode: event.eventData.dynamicWorkflowCode,
          },
        }));

        const run = await start(source, {
          experimental_dynamic: dynamic,
          experimental_idempotencyKey: KEY,
        });

        expect(run.experimental_started).toBe(true);
        expect(eventsCreate.mock.calls[0][1].eventData).toMatchObject({
          idempotencyKey: KEY,
        });
        expect(queue).toHaveBeenCalledOnce();
        expect(queue.mock.invocationCallOrder[0]).toBeGreaterThan(
          eventsCreate.mock.invocationCallOrder[0]
        );
      });

      it('returns the holder of a keyed dynamic start', async () => {
        dynamicKeyedWorld();
        eventsCreate.mockRejectedValue(refusal('running'));

        const run = await start(source, {
          experimental_dynamic: dynamic,
          experimental_idempotencyKey: KEY,
        });

        expect(run.runId).toBe(HOLDER);
        expect(run.experimental_started).toBe(false);
        expect(queue).not.toHaveBeenCalled();
      });
    });

    it.each([
      ['a throttle', () => new ThrottleError('rate limited')],
      [
        'a 5xx',
        () => new WorkflowWorldError('Internal Server Error', { status: 500 }),
      ],
      [
        'a transport failure',
        () => new WorkflowWorldError('socket hang up', { code: 'TRANSPORT' }),
      ],
      ['a 400', () => new WorkflowWorldError('Bad Request', { status: 400 })],
    ])('throws %s with nothing published: keyed starts have no resilient start', async (_label, makeError) => {
      keyedWorld();
      const error = makeError();
      eventsCreate.mockRejectedValue(error);

      await expect(
        start(keyedWorkflow, [], { experimental_idempotencyKey: KEY })
      ).rejects.toBe(error);
      expect(queue).not.toHaveBeenCalled();
    });

    it('surfaces the backend kill switch as a non-retryable error, with nothing published', async () => {
      keyedWorld();
      const disabled = new WorkflowWorldError(
        'Run idempotency keys are switched off on this Workflow backend, so no run was created.',
        { status: 400, code: 'idempotency-keys-disabled' }
      );
      eventsCreate.mockRejectedValue(disabled);

      const thrown = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
      }).catch((err: unknown) => err);

      expect(thrown).toBe(disabled);
      expect(isRetryableWorldError(thrown)).toBe(false);
      expect(queue).not.toHaveBeenCalled();
      expect(runsGet).not.toHaveBeenCalled();
    });

    it('throws when the publish of a created run fails', async () => {
      keyedWorld();
      queue.mockRejectedValue(new Error('Queue unavailable'));
      await expect(
        start(keyedWorkflow, [], { experimental_idempotencyKey: KEY })
      ).rejects.toThrow('Queue unavailable');
    });

    it('warns and still publishes when the backend does not echo the key', async () => {
      keyedWorld();
      const warn = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
      eventsCreate.mockImplementation(async (runId) => ({
        run: { runId, status: 'pending' },
      }));

      const run = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
      });

      expect(run.experimental_started).toBe(true);
      expect(queue).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/did not record its idempotency key/),
        expect.objectContaining({ workflowRunId: run.runId })
      );
    });

    it.each([
      ['no capabilities', undefined],
      ['the capability unset', {}],
      ['the capability false', { runIdempotencyKeys: false }],
    ])('refuses a keyed start on a World with %s, before any I/O', async (_label, capabilities) => {
      const getEncryptionKeyForRun = vi.fn();
      const createRunId = vi.fn();
      keyedWorld({ capabilities, getEncryptionKeyForRun, createRunId });

      const error = await start(keyedWorkflow, [], {
        experimental_idempotencyKey: KEY,
      }).catch((err: unknown) => err);

      expect(WorkflowRuntimeError.is(error)).toBe(true);
      expect((error as Error).message).toMatch(
        /capabilities\.runIdempotencyKeys/
      );
      expect(getDeploymentId).not.toHaveBeenCalled();
      expect(createRunId).not.toHaveBeenCalled();
      expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, unknown>]>([
      ['an empty key', { experimental_idempotencyKey: '' }],
      [
        'a key over 256 characters',
        { experimental_idempotencyKey: 'k'.repeat(257) },
      ],
      ['a non-string key', { experimental_idempotencyKey: 42 }],
      ['a TTL without a key', { experimental_idempotencyKeyTTL: '1h' }],
      [
        'a reuse policy without a key',
        { experimental_idempotencyKeyReusePolicy: 'ALLOW_DUPLICATE' },
      ],
      [
        'a conflict policy without a key',
        { experimental_idempotencyKeyConflictPolicy: 'FAIL' },
      ],
      [
        'a TTL under 1s',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyTTL: '999ms',
        },
      ],
      [
        'a numeric TTL under 1s',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyTTL: 999,
        },
      ],
      [
        'a TTL over 30d',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyTTL: '31d',
        },
      ],
      [
        'a numeric TTL over 30d',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyTTL: 2_592_000_001,
        },
      ],
      [
        'an unparseable TTL',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyTTL: 'soon',
        },
      ],
      [
        'a fractional numeric TTL',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyTTL: 1500.5,
        },
      ],
      [
        'a negative TTL',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyTTL: -1,
        },
      ],
      [
        'an unknown reuse policy',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyReusePolicy: 'SOMETIMES',
        },
      ],
      [
        'an unknown conflict policy',
        {
          experimental_idempotencyKey: KEY,
          experimental_idempotencyKeyConflictPolicy: 'OVERWRITE',
        },
      ],
    ])('rejects %s before any I/O', async (_label, options) => {
      // Even a World with the capability never sees an invalid start.
      keyedWorld();

      const error = await start(keyedWorkflow, [], options as any).catch(
        (err: unknown) => err
      );

      expect(WorkflowRuntimeError.is(error)).toBe(true);
      expect((error as Error).message).toMatch(/experimental_idempotencyKey/);
      expect(getDeploymentId).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    });

    it('names every orphaned option in one error', () => {
      expect(() =>
        resolveIdempotencyOptions({
          experimental_idempotencyKeyTTL: '1h',
          experimental_idempotencyKeyConflictPolicy: 'FAIL',
        })
      ).toThrow(
        /experimental_idempotencyKeyTTL, experimental_idempotencyKeyConflictPolicy.*requires experimental_idempotencyKey/
      );
    });

    it('resolves defaults and accepts the bounds', () => {
      expect(resolveIdempotencyOptions({})).toBeUndefined();
      expect(
        resolveIdempotencyOptions({ experimental_idempotencyKey: KEY })
      ).toEqual({
        key: KEY,
        ttlMs: 86_400_000,
        reusePolicy: 'REJECT_DUPLICATE',
        conflictPolicy: 'USE_EXISTING',
      });
      for (const [ttl, ttlMs] of [
        ['1s', 1_000],
        [1_000, 1_000],
        ['30d', 2_592_000_000],
        [2_592_000_000, 2_592_000_000],
        [60_000, 60_000],
      ] as const) {
        expect(
          resolveIdempotencyOptions({
            experimental_idempotencyKey: KEY,
            experimental_idempotencyKeyTTL: ttl,
          })?.ttlMs
        ).toBe(ttlMs);
      }
      expect(
        resolveIdempotencyOptions({
          experimental_idempotencyKey: 'k'.repeat(256),
          experimental_idempotencyKeyReusePolicy: 'ALLOW_DUPLICATE',
          experimental_idempotencyKeyConflictPolicy: 'FAIL',
        })
      ).toMatchObject({
        reusePolicy: 'ALLOW_DUPLICATE',
        conflictPolicy: 'FAIL',
      });
    });

    describe('region inside a step', () => {
      function insideRun<T>(parentRunId: string, fn: () => Promise<T>) {
        return contextStorage.run(
          {
            stepMetadata: {
              stepName: 'start',
              stepId: 'step_1',
              stepStartedAt: new Date(),
              attempt: 2,
            },
            workflowMetadata: {
              workflowName: 'parent',
              workflowRunId: parentRunId,
              workflowStartedAt: new Date(),
              url: 'http://localhost:3000',
              features: { encryption: false },
            },
            ops: [],
          } as any,
          fn
        );
      }

      it("mints a keyed child in the parent run's region by default", async () => {
        const createRunId = vi
          .fn()
          .mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV');
        const regionForRunId = vi.fn().mockReturnValue('cle1');
        keyedWorld({ createRunId, regionForRunId });

        await insideRun('wrun_parent', () =>
          start(keyedWorkflow, [], { experimental_idempotencyKey: KEY })
        );

        expect(regionForRunId).toHaveBeenCalledWith('wrun_parent');
        expect(createRunId).toHaveBeenCalledWith(
          expect.objectContaining({ region: 'cle1' })
        );
        // The queue routes by the region tagged into the run id.
        expect(queue.mock.calls[0][2]).not.toHaveProperty('region');
      });

      it('keeps an explicit region', async () => {
        const createRunId = vi
          .fn()
          .mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV');
        const regionForRunId = vi.fn().mockReturnValue('cle1');
        keyedWorld({ createRunId, regionForRunId });

        await insideRun('wrun_parent', () =>
          start(keyedWorkflow, [], {
            experimental_idempotencyKey: KEY,
            region: 'fra1',
          })
        );

        expect(regionForRunId).not.toHaveBeenCalled();
        expect(createRunId).toHaveBeenCalledWith(
          expect.objectContaining({ region: 'fra1' })
        );
      });

      it('leaves unkeyed and top-level starts alone', async () => {
        const createRunId = vi
          .fn()
          .mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV');
        const regionForRunId = vi.fn().mockReturnValue('cle1');
        keyedWorld({ createRunId, regionForRunId });

        await insideRun('wrun_parent', () => start(keyedWorkflow, []));
        await start(keyedWorkflow, [], { experimental_idempotencyKey: KEY });

        expect(regionForRunId).not.toHaveBeenCalled();
        expect(createRunId.mock.calls[0][0]).not.toHaveProperty('region');
        expect(createRunId.mock.calls[1][0]).not.toHaveProperty('region');
      });
    });

    describe('span attributes', () => {
      function captureSpan() {
        const attributes: Record<string, unknown> = {};
        const span = {
          setAttributes: (attrs: Record<string, unknown>) =>
            Object.assign(attributes, attrs),
        };
        vi.mocked(trace).mockImplementationOnce(((_name: string, fn: any) =>
          fn(span)) as any);
        return attributes;
      }

      it('records a created keyed start', async () => {
        keyedWorld();
        const attributes = captureSpan();
        const run = await start(keyedWorkflow, [], {
          experimental_idempotencyKey: KEY,
        });
        expect(attributes).toMatchObject({
          'workflow.start.idempotency_key_present': true,
          'workflow.start.idempotency_outcome': 'created',
          'workflow.run.id': run.runId,
        });
      });

      it('records a start that returned the existing holder', async () => {
        keyedWorld();
        eventsCreate.mockRejectedValue(refusal('running'));
        const attributes = captureSpan();
        await start(keyedWorkflow, [], { experimental_idempotencyKey: KEY });
        expect(attributes).toMatchObject({
          'workflow.start.idempotency_key_present': true,
          'workflow.start.idempotency_outcome': 'existing',
          'workflow.run.id': HOLDER,
        });
      });

      it('records nothing about keys on an unkeyed start', async () => {
        keyedWorld();
        const attributes = captureSpan();
        await start(keyedWorkflow, []);
        expect(attributes).not.toHaveProperty(
          'workflow.start.idempotency_key_present'
        );
        expect(attributes).not.toHaveProperty(
          'workflow.start.idempotency_outcome'
        );
      });
    });

    describe('unkeyed starts', () => {
      it('report experimental_started and keep the parallel publish', async () => {
        keyedWorld();
        const run = await start(keyedWorkflow, []);
        expect(run.experimental_started).toBe(true);
        expect(eventsCreate.mock.calls[0][1].eventData).not.toHaveProperty(
          'idempotencyKey'
        );
        expect(queue.mock.calls[0][2]).not.toHaveProperty('idempotencyKey');
      });

      it('report experimental_started on a resilient start too', async () => {
        keyedWorld();
        eventsCreate.mockRejectedValue(
          new WorkflowWorldError('Internal Server Error', { status: 500 })
        );
        vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
        const run = await start(keyedWorkflow, [], {
          specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
        });
        expect(run.experimental_started).toBe(true);
      });

      it('work on a World without the capability', async () => {
        keyedWorld({ capabilities: undefined });
        const run = await start(keyedWorkflow, []);
        expect(run.experimental_started).toBe(true);
      });
    });
  });
});
