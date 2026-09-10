import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RunExpiredError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import {
  type ActorCommand,
  ActorCommandSchema,
  ActorInvariantError,
  type ActorSnapshot,
  actorEventResult,
  assertActorSnapshot,
  type CreateEventRequest,
  type Event,
  type EventResult,
  getQueueTopicPrefix,
  projectActorSnapshot,
  resolveQueueNamespace,
  type World,
} from '@workflow/world';
import { importKey } from '../encryption.js';
import { ReplayPayloadCache } from '../replay-payload-cache.js';
import {
  replayWorkflow,
  resumeWorkflow,
  type WorkflowSession,
} from '../workflow.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import { executeStep } from './step-executor.js';
import { handleSuspension } from './suspension-handler.js';
import { runWithWorld } from './world.js';

const coordinators = globalSingleton(
  '@workflow/core//actor-coordinators',
  1,
  () => new WeakMap<World, Map<string, ActorCoordinator>>()
);

/** One primary per run, with a commit lane distinct from awaited user bodies. */
export class ActorCoordinator {
  readonly activationId = `${COMPUTE_INSTANCE_ID}:${randomUUID()}`;
  private snapshot?: ActorSnapshot;
  private loading?: Promise<void>;
  private commits: Promise<unknown> = Promise.resolve();
  private driving?: Promise<void>;
  private fault?: Error;
  private session?: WorkflowSession;
  private readonly ingress: Array<{
    command: ActorCommand;
    resolve(value: EventResult): void;
    reject(error: unknown): void;
  }> = [];
  private phase: 'idle' | 'vm' | 'body' = 'idle';
  private sequence = 0;
  readonly boundWorld: World;

  constructor(
    private readonly world: World,
    private readonly runId: string,
    private readonly code: string,
    private readonly namespace?: string
  ) {
    if (!world.execution)
      throw new Error('Actor execution adapter is required');
    this.boundWorld = {
      ...world,
      events: {
        ...world.events,
        create: ((
          id: string,
          event: CreateEventRequest,
          params?: { resumeId?: string }
        ) => {
          if (id !== runId) return world.events.create(id, event);
          return this.append(event, params?.resumeId);
        }) as World['events']['create'],
      },
      runs: {
        ...world.runs,
        get: (async (id: string) =>
          id === runId
            ? this.view().run
            : world.runs.get(id)) as World['runs']['get'],
      },
      steps: {
        ...world.steps,
        get: (async (id: string, stepId: string) => {
          if (id !== runId) return world.steps.get(id, stepId);
          const step = this.view().steps.get(stepId);
          if (!step)
            throw new ActorInvariantError('Step missing from primary journal');
          return step;
        }) as World['steps']['get'],
      },
    };
  }

  private view() {
    if (!this.snapshot)
      throw new ActorInvariantError('Primary used before initialization');
    return projectActorSnapshot(this.snapshot);
  }

  async initialize(): Promise<void> {
    this.check();
    this.loading ??= (async () => {
      const snapshot = await this.world.execution!.acquire(this.runId);
      assertActorSnapshot(snapshot);
      if (snapshot.deploymentId !== (await this.world.getDeploymentId())) {
        throw new ActorInvariantError('Primary reached the wrong deployment');
      }
      this.snapshot = snapshot;
      this.view();
    })().catch(async (error) => {
      await this.stop(error);
      throw error;
    });
    await this.loading;
  }

  private check(): void {
    if (this.fault) throw this.fault;
  }

  private async stop(error: unknown): Promise<void> {
    if (this.fault) return;
    this.fault =
      error instanceof Error ? error : new ActorInvariantError(String(error));
    for (const item of this.ingress.splice(0)) item.reject(this.fault);
    console.error('[workflow actor stopped]', {
      runId: this.runId,
      activationId: this.activationId,
      computeInstanceId: COMPUTE_INSTANCE_ID,
      error: this.fault.message,
    });
    // Persist independently of the broken journal. No terminal append or repair.
    await this.world.execution!.quarantine(this.runId, {
      code: 'ACTOR_INVARIANT_VIOLATION',
      message: this.fault.message.slice(0, 1000),
      activationId: this.activationId,
    });
  }

  append(event: CreateEventRequest, identity?: string): Promise<EventResult> {
    const operationId = identity ?? `${this.activationId}:${++this.sequence}`;
    const task = this.commits
      .then(async () => {
        this.check();
        const snapshot = this.snapshot!;
        if (identity) {
          const prior = await this.world.execution!.receipt(
            this.runId,
            identity
          );
          if (prior) {
            const recorded = prior.events[prior.events.length - 1];
            const {
              eventId: _eventId,
              createdAt: _at,
              runId: _runId,
              ...request
            } = recorded;
            if (!isDeepStrictEqual(request, event))
              throw new ActorInvariantError(
                'Submission ID reused with different input'
              );
            if (
              !isDeepStrictEqual(
                snapshot.events.find((e) => e.eventId === recorded.eventId),
                recorded
              )
            ) {
              throw new ActorInvariantError(
                'Submission receipt is not in the primary committed prefix'
              );
            }
            return actorEventResult(snapshot, recorded);
          }
        }
        if (
          ['completed', 'failed', 'cancelled'].includes(this.view().run.status)
        ) {
          throw new RunExpiredError('Actor run is terminal');
        }
        // Validate our proposed history before writing it; never repair after failure.
        const proposed = {
          ...event,
          runId: this.runId,
          eventId: `evnt_${String(snapshot.head + 1).padStart(26, '0')}`,
          createdAt: new Date(),
        } as Event;
        projectActorSnapshot({
          ...snapshot,
          head: snapshot.head + 1,
          events: [...snapshot.events, proposed],
        });
        const receipt = await this.world.execution!.exchange({
          runId: this.runId,
          deploymentId: snapshot.deploymentId,
          activationId: this.activationId,
          operationId,
          expectedHead: snapshot.head,
          events: [event],
        });
        if (receipt.operationId !== operationId)
          throw new ActorInvariantError('Receipt identity mismatch');
        if (receipt.head <= snapshot.head) {
          for (const existing of receipt.events) {
            if (
              !isDeepStrictEqual(
                snapshot.events.find((e) => e.eventId === existing.eventId),
                existing
              )
            ) {
              throw new ActorInvariantError(
                'Duplicate receipt disagrees with committed history'
              );
            }
          }
        } else {
          if (receipt.head !== snapshot.head + receipt.events.length)
            throw new ActorInvariantError('Unexpected committed head');
          snapshot.events.push(...receipt.events);
          snapshot.head = receipt.head;
          assertActorSnapshot(snapshot);
        }
        return actorEventResult(
          snapshot,
          receipt.events[receipt.events.length - 1]
        );
      })
      .catch(async (error) => {
        if (!RunExpiredError.is(error)) await this.stop(error);
        throw error;
      });
    // Settle the lane, not the operation: the caller receives the rejection and
    // the sticky fault rejects every future write. No retry or repaired state.
    this.commits = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  async receive(command?: ActorCommand): Promise<void> {
    await this.initialize();
    this.check();
    let submitted: Promise<unknown> = Promise.resolve();
    if (command) {
      if (this.phase === 'body')
        submitted = this.append(command.event, command.operationId);
      else {
        if (this.ingress.length >= 128)
          throw new Error('Actor ingress capacity exceeded');
        submitted = new Promise((resolve, reject) =>
          this.ingress.push({ command, resolve, reject })
        );
      }
    }
    // Share one drive promise across concurrent VQS requests. Never replay another
    // orchestrator just because a second message arrives on the same cell.
    this.driving ??= runWithWorld(this.boundWorld, () => this.drive())
      .catch(async (error) => {
        await this.stop(error);
        throw error;
      })
      .finally(() => {
        this.driving = undefined;
        this.phase = 'idle';
      });
    // Observe rejection immediately, but re-drive an input that raced the
    // previous drive's final return before waiting for its journal receipt.
    const outcome = submitted.then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error })
    );
    await this.driving;
    if (this.ingress.length) await this.receive();
    const result = await outcome;
    if (!result.ok) throw result.error;
  }

  private async drive(): Promise<void> {
    const until = Date.now() + 60_000;
    const rawKey = await this.world.getEncryptionKeyForRun?.(this.view().run);
    const encryptionKey = rawKey ? await importKey(rawKey) : undefined;
    const replayPayloadCache = new ReplayPayloadCache(encryptionKey);
    while (true) {
      this.check();
      this.phase = 'vm';
      for (const item of this.ingress.splice(0)) {
        try {
          item.resolve(
            await this.append(item.command.event, item.command.operationId)
          );
        } catch (error) {
          item.reject(error);
          throw error;
        }
      }
      if (['completed', 'failed', 'cancelled'].includes(this.view().run.status))
        return;
      if (!this.view().run.startedAt)
        await this.append({
          eventType: 'run_started',
          specVersion: this.world.specVersion,
        });
      for (const wait of this.view().waits.values()) {
        if (
          wait.status === 'waiting' &&
          wait.resumeAt &&
          wait.resumeAt.getTime() <= Date.now()
        ) {
          await this.append({
            eventType: 'wait_completed',
            correlationId: wait.waitId,
            specVersion: this.world.specVersion,
            eventData: { resumeAt: wait.resumeAt },
          });
        }
      }
      if (Date.now() >= until) {
        await this.schedule(0);
        return;
      }
      const before = this.snapshot!.head;
      const result = this.session
        ? await resumeWorkflow(this.session, [...this.snapshot!.events])
        : await replayWorkflow({
            workflowCode: this.code,
            workflowRun: this.view().run,
            events: [...this.snapshot!.events],
            encryptionKey,
            replayPayloadCache,
            worldCapabilities: this.world.capabilities,
          });
      this.check();
      if (result.type === 'replay')
        throw new ActorInvariantError(
          'Retained actor session declined; automatic replay is forbidden'
        );
      if (result.type === 'completed') {
        await this.append({
          eventType: 'run_completed',
          specVersion: this.world.specVersion,
          eventData: { output: result.output },
        });
        this.session = undefined;
        return;
      }
      this.session = result.session;
      const handled = await handleSuspension({
        suspension: result.suspension,
        world: this.boundWorld,
        run: this.view().run,
      });
      if (handled.serializationBlockerCount)
        throw new ActorInvariantError(
          'Actor POC does not support retention-unsafe serialization'
        );
      // Make every creation durable before any body starts. No lazy speculative
      // start and no queue overflow. The POC runs a bounded sequential body lane.
      for (const step of handled.lazyInlineSteps) {
        await this.append({
          eventType: 'step_created',
          specVersion: this.world.specVersion,
          correlationId: step.correlationId,
          eventData: { stepName: step.stepName, input: step.dehydratedInput },
        });
      }
      const ids = new Set([
        ...handled.pendingSteps.map((s) => s.correlationId),
        ...handled.lazyInlineSteps.map((s) => s.correlationId),
      ]);
      this.phase = 'body';
      let executed = false;
      for (const stepId of ids) {
        this.check();
        if (!['pending', 'running'].includes(this.view().run.status)) return;
        const step = this.view().steps.get(stepId);
        if (!step)
          throw new ActorInvariantError(
            'Scheduled step has no committed creation'
          );
        if (step.retryAfter && step.retryAfter.getTime() > Date.now()) continue;
        if (Date.now() >= until) {
          await this.schedule(0);
          return;
        }
        const outcome = await executeStep({
          world: this.boundWorld,
          workflowRunId: this.runId,
          workflowDeploymentId: this.snapshot!.deploymentId,
          workflowName: this.view().run.workflowName,
          workflowStartedAt: this.view().run.startedAt!.getTime(),
          stepId,
          stepName: step.stepName,
          runSpecVersion: this.world.specVersion,
          suppressOptimisticStart: true,
          authoritativeAttempt: step.attempt + 1,
        });
        if (outcome.type === 'skipped' || outcome.type === 'throttled') {
          throw new ActorInvariantError(
            `Unexpected inline body outcome: ${outcome.type}`
          );
        }
        executed = true;
      }
      if (this.ingress.length || executed || this.snapshot!.head !== before)
        continue;
      const deadlines = [
        ...[...this.view().waits.values()]
          .filter((w) => w.status === 'waiting')
          .map((w) => w.resumeAt?.getTime()),
        ...[...this.view().steps.values()]
          .filter((s) => s.status === 'pending')
          .map((s) => s.retryAfter?.getTime()),
      ].filter((value): value is number => value !== undefined);
      if (deadlines.length)
        await this.schedule(
          Math.max(0, (Math.min(...deadlines) - Date.now()) / 1000)
        );
      return;
    }
  }

  private async schedule(delaySeconds: number) {
    this.check();
    await this.world.queue(
      `${getQueueTopicPrefix('workflow', resolveQueueNamespace(this.namespace))}${this.view().run.workflowName}`,
      { runId: this.runId },
      {
        deploymentId: this.snapshot!.deploymentId,
        delaySeconds: Math.min(23 * 3600, Math.ceil(delaySeconds)),
      }
    );
  }
}

export function actorWorkflowHandler(
  code: string,
  world: World,
  namespace?: string
) {
  const deliveryAffinity = new AsyncLocalStorage<string>();
  let registry = coordinators.get(world);
  if (!registry) {
    registry = new Map();
    coordinators.set(world, registry);
  }
  const handler = world.createQueueHandler(
    getQueueTopicPrefix('workflow', resolveQueueNamespace(namespace)),
    async (payload) => {
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('runId' in payload) ||
        typeof payload.runId !== 'string'
      )
        throw new Error('Actor delivery requires runId');
      const runId = payload.runId;
      if (deliveryAffinity.getStore() !== runId) {
        const fault = {
          code: 'ACTOR_INVARIANT_VIOLATION' as const,
          message: 'Delivered affinity ID does not equal run ID',
          activationId: COMPUTE_INSTANCE_ID,
        };
        await world.execution!.quarantine(runId, fault);
        throw new ActorInvariantError(fault.message);
      }
      let coordinator = registry!.get(runId);
      if (!coordinator) {
        if (registry!.size >= 128)
          throw new Error('Actor POC coordinator capacity exceeded');
        coordinator = new ActorCoordinator(world, runId, code, namespace);
        registry!.set(runId, coordinator);
      }
      await coordinator.receive(
        'actorCommand' in payload && payload.actorCommand !== undefined
          ? ActorCommandSchema.parse(payload.actorCommand)
          : undefined
      );
    }
  );
  return async (request: Request) => {
    const header = process.env.WORKFLOW_ACTOR_AFFINITY_HEADER;
    if (!header || !request.headers.get(header))
      throw new ActorInvariantError(
        'Actor invocation is missing its configured affinity header'
      );
    // The callback body is decoded/authenticated by the VQS handler. Bind the
    // received header to the run inside the callback via a per-request wrapper.
    return deliveryAffinity.run(request.headers.get(header)!, () =>
      handler(request)
    );
  };
}
