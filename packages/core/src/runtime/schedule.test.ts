import { HookConflictError } from '@workflow/errors';
import { ValidQueueName } from '@workflow/world';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

const { startMock } = vi.hoisted(() => ({ startMock: vi.fn() }));
vi.mock('./start.js', () => ({ start: startMock }));

const {
  decodeScheduleTopicSuffix,
  encodeScheduleTopicSuffix,
  handleScheduleDelivery,
  parseScheduleDelivery,
  scheduleStartToken,
  scheduleTarget,
  scheduleTopic,
} = await import('./schedule.js');
type ScheduledRun<
  T extends import('./schedule.js').ScheduleJsonValue | undefined = undefined,
> = import('./schedule.js').ScheduledRun<T>;

// What the compiler's client transform attaches to a workflow function.
const asWorkflow = <T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
  workflowId: string
): T => Object.assign(fn, { workflowId });

const nightlyReport = asWorkflow(
  async (_run: ScheduledRun) => undefined,
  'workflow//./workflows/nightly-report//nightlyReport'
);
const sendDigest = asWorkflow(
  async (_run: ScheduledRun<{ userId: string }>) => undefined,
  'workflow//./src/workflows/digest//sendDigest'
);

/** The characters a compiled workflow name can hold (`SAFE_WORKFLOW_NAME_PATTERN`). */
const NAME_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./@()[]';
const TOPIC_PATTERN = /^[A-Za-z0-9_-]+$/;

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('schedule topics', () => {
  it('reads like the workflow it starts', () => {
    expect(scheduleTopic(nightlyReport)).toBe(
      '__wkf_workflow_schedule_workflows_snightly-report__nightlyReport'
    );
    expect(scheduleTopic(sendDigest)).toBe(
      '__wkf_workflow_schedule_src_sworkflows_sdigest__sendDigest'
    );
  });

  it('marks a workflow from a package, whose module path has no leading ./', () => {
    const name = 'workflow//@acme/jobs/dist/index.js//cleanup';
    expect(encodeScheduleTopicSuffix(name)).toBe(
      '_p_aacme_sjobs_sdist_sindex_djs__cleanup'
    );
    expect(
      decodeScheduleTopicSuffix('_p_aacme_sjobs_sdist_sindex_djs__cleanup')
    ).toBe(name);
  });

  it('is a topic Vercel Schedules accepts and the flow route consumes', () => {
    const topic = scheduleTopic(nightlyReport);
    // Schedule topics: letters, digits, `_` and `-` only.
    expect(topic).toMatch(TOPIC_PATTERN);
    // The flow route's `__wkf_workflow_*` trigger and the World's queue names.
    expect(ValidQueueName.safeParse(topic).success).toBe(true);
  });

  it('follows the queue namespace', () => {
    expect(scheduleTopic(nightlyReport, { namespace: 'acme' })).toBe(
      '__acme_wkf_workflow_schedule_workflows_snightly-report__nightlyReport'
    );
  });

  it('round-trips every workflow name (property test over 2,000 random names)', () => {
    const random = seeded(20261109);
    for (let n = 0; n < 2000; n++) {
      const part = () =>
        Array.from(
          { length: 1 + Math.floor(random() * 12) },
          () => NAME_CHARS[Math.floor(random() * NAME_CHARS.length)]
        ).join('');
      const modulePath = random() < 0.8 ? `./${part()}` : part();
      const name = `workflow//${modulePath}//${part()}`;
      const suffix = encodeScheduleTopicSuffix(name);
      expect(suffix).toMatch(TOPIC_PATTERN);
      expect(decodeScheduleTopicSuffix(suffix)).toBe(name);
    }
  });

  it('gives different workflows different topics', () => {
    const names = [
      'workflow//./a/b//c',
      'workflow//./a_b//c',
      'workflow//./a//b//c',
      'workflow//./a.b//c',
      'workflow//a/b//c',
      'workflow//./a-b//c',
    ];
    const suffixes = names.map(encodeScheduleTopicSuffix);
    expect(new Set(suffixes).size).toBe(names.length);
  });

  it('refuses what is not a compiled workflow', () => {
    expect(() => encodeScheduleTopicSuffix('not-a-workflow')).toThrow(
      /only workflows compiled into the deployment/
    );
    expect(() => scheduleTopic((async () => undefined) as never)).toThrow(
      /'use workflow' directive/
    );
  });

  it('decodes nothing from a suffix no workflow encodes to', () => {
    expect(decodeScheduleTopicSuffix('')).toBeUndefined();
    expect(decodeScheduleTopicSuffix('bad_xescape')).toBeUndefined();
    expect(decodeScheduleTopicSuffix('trailing_')).toBeUndefined();
    expect(decodeScheduleTopicSuffix('has space')).toBeUndefined();
  });
});

describe('scheduleTarget', () => {
  it('spreads into Schedules.create() with the payload the workflow expects', () => {
    expect(scheduleTarget(sendDigest, { userId: 'u1' })).toEqual({
      target: {
        topic: '__wkf_workflow_schedule_src_sworkflows_sdigest__sendDigest',
      },
      payload: { userId: 'u1' },
    });
    expect(scheduleTarget(nightlyReport)).toEqual({
      target: {
        topic:
          '__wkf_workflow_schedule_workflows_snightly-report__nightlyReport',
      },
    });
  });

  it('type-checks the payload against the workflow', () => {
    expectTypeOf(
      scheduleTarget(sendDigest, { userId: 'u1' }).payload
    ).toEqualTypeOf<{ userId: string } | undefined>();
    // @ts-expect-error the payload is required by the workflow
    scheduleTarget(sendDigest);
    // @ts-expect-error the payload has the wrong shape
    scheduleTarget(sendDigest, { user: 'u1' });
    // @ts-expect-error a workflow without a payload takes none
    scheduleTarget(nightlyReport, { userId: 'u1' });
    const takesDate = asWorkflow(
      async (_at: Date) => undefined,
      'workflow//./x//y'
    );
    // @ts-expect-error a workflow that does not take a ScheduledRun is not a schedule target
    scheduleTarget(takesDate);
  });
});

function mustParse(message: unknown) {
  const delivery = parseScheduleDelivery(message);
  if (!delivery) throw new Error('not a schedule delivery');
  return delivery;
}

describe('handleScheduleDelivery', () => {
  afterEach(() => {
    startMock.mockReset();
  });

  const delivery = mustParse({
    __scheduleDelivery: true,
    scheduleId: 'sch_1',
    executionId: 'schx_1',
    name: `digest-u1`,
    namespace: 'u1',
    scheduledAt: '2026-11-10T09:00:00.000Z',
    source: 'dynamic',
    expression: '0 9 * * *',
    payload: { userId: 'u1' },
  });
  const context = {
    queueName: scheduleTopic(sendDigest),
    workflowPrefix: '__wkf_workflow_',
    attempt: 1,
  };

  it('starts the topic workflow with the occurrence, keyed by its execution', async () => {
    startMock.mockResolvedValue({ runId: 'wrun_1' });
    await handleScheduleDelivery(delivery, context);

    expect(startMock).toHaveBeenCalledTimes(1);
    const [workflow, args, options] = startMock.mock.calls[0];
    expect(workflow).toEqual({
      workflowId: 'workflow//./src/workflows/digest//sendDigest',
    });
    expect(args).toEqual([
      {
        scheduleId: 'sch_1',
        executionId: 'schx_1',
        name: 'digest-u1',
        namespace: 'u1',
        scheduledAt: new Date('2026-11-10T09:00:00.000Z'),
        source: 'dynamic',
        expression: '0 9 * * *',
        payload: { userId: 'u1' },
      },
    ]);
    expect(options).toEqual({
      experimental_hook: {
        token: 'schedule:sch_1:schx_1',
        experimental_minRetention: '7 days',
      },
    });
    expect(scheduleStartToken(delivery)).toBe('schedule:sch_1:schx_1');
  });

  it('acknowledges a redelivery whose run already started', async () => {
    startMock.mockRejectedValue(
      new HookConflictError('schedule:sch_1:schx_1', 'wrun_1', {
        kind: 'start',
      })
    );
    await expect(
      handleScheduleDelivery(delivery, context)
    ).resolves.toBeUndefined();
  });

  it('lets the queue retry a start that failed for another reason', async () => {
    const failure = new Error('backend unavailable');
    startMock.mockRejectedValue(failure);
    await expect(handleScheduleDelivery(delivery, context)).rejects.toBe(
      failure
    );
  });

  it('starts nothing for a topic that names no workflow, and does not retry it', async () => {
    await expect(
      handleScheduleDelivery(delivery, {
        ...context,
        queueName: '__wkf_workflow_schedule_bad_x',
      })
    ).resolves.toBeUndefined();
    await expect(
      handleScheduleDelivery(delivery, {
        ...context,
        queueName: '__wkf_workflow_other',
      })
    ).resolves.toBeUndefined();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('gives up on an occurrence past the delivery cap', async () => {
    await expect(
      handleScheduleDelivery(delivery, { ...context, attempt: 10_000 })
    ).resolves.toBeUndefined();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('passes a static schedule an occurrence without a payload', async () => {
    startMock.mockResolvedValue({ runId: 'wrun_2' });
    const staticDelivery = mustParse({
      __scheduleDelivery: true,
      scheduleId: 'sch_2',
      executionId: 'schx_2',
      name: 'nightly-report',
      namespace: 'default',
      scheduledAt: '2026-11-10T07:00:00.000Z',
      source: 'static',
    });
    await handleScheduleDelivery(staticDelivery, {
      ...context,
      queueName: scheduleTopic(nightlyReport),
    });
    const [workflow, [run]] = startMock.mock.calls[0];
    expect(workflow).toEqual({
      workflowId: 'workflow//./workflows/nightly-report//nightlyReport',
    });
    expect(run).toMatchObject({ source: 'static', payload: undefined });
    expect(run).not.toHaveProperty('expression');
  });

  it('only reads payloads that are schedule deliveries', () => {
    expect(parseScheduleDelivery({ runId: 'wrun_1' })).toBeUndefined();
    expect(
      parseScheduleDelivery({ scheduleId: 'sch_1', executionId: 'schx_1' })
    ).toBeUndefined();
  });
});
