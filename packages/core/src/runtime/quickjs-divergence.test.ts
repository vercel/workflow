import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  findReplayDivergence,
  type VmKnownOp,
  type VmReplayView,
} from './quickjs-divergence.js';

/**
 * Unit coverage for the QuickJS engine's replay-divergence arbitration —
 * the pure core behind the fixed-point sweep in quickjs-runtime.ts. The
 * semantics mirror the node:vm engine's EventsConsumer checks: every
 * non-structural event must be claimed by an operation the replay drew,
 * with matching identity fields.
 */

function makeEvent(overrides: Partial<Record<string, unknown>>): Event {
  return {
    eventId: 'evnt_01TEST',
    runId: 'wrun_test',
    eventType: 'step_created',
    correlationId: 'step_01AAAA',
    eventData: {},
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as Event;
}

function view(ops: VmKnownOp[], extra?: Partial<VmReplayView>): VmReplayView {
  return { ops, ...extra };
}

describe('findReplayDivergence', () => {
  describe('structural events (never require a claim)', () => {
    it.each([
      ['run_created', {}],
      ['run_started', {}],
      ['run_completed', {}],
      ['run_failed', {}],
    ])('skips %s', (eventType) => {
      const events = [makeEvent({ eventType, correlationId: 'wrun_test' })];
      expect(findReplayDivergence(events, view([]))).toBeNull();
    });

    it('skips untracked events without a correlationId', () => {
      const events = [
        makeEvent({ eventType: 'some_future_event', correlationId: undefined }),
      ];
      expect(findReplayDivergence(events, view([]))).toBeNull();
    });

    it('reports a tracked-family event missing its correlationId as divergence', () => {
      // A step/wait/hook event without a correlation id is a malformed log
      // entry — no replay can ever claim it, so skipping it would declare a
      // log reproduced that was not.
      const events = [
        makeEvent({
          eventType: 'step_created',
          correlationId: undefined,
          eventId: 'evnt_NOCID',
        }),
      ];
      const err = findReplayDivergence(events, view([]));
      expect(err).not.toBeNull();
      expect(err?.message).toContain('missing a correlationId');
      expect(err?.eventId).toBe('evnt_NOCID');
    });

    it('skips attr_set events written by a step', () => {
      const events = [
        makeEvent({
          eventType: 'attr_set',
          correlationId: 'attr_01AAAA',
          eventData: { changes: {}, writer: { type: 'step' } },
        }),
      ];
      expect(findReplayDivergence(events, view([]))).toBeNull();
    });

    it('skips event types outside the tracked families', () => {
      const events = [
        makeEvent({ eventType: 'some_future_event', correlationId: 'x_1' }),
      ];
      expect(findReplayDivergence(events, view([]))).toBeNull();
    });
  });

  describe('orphaned events', () => {
    it('reports a step event for a correlation id the replay never drew', () => {
      const events = [
        makeEvent({
          eventType: 'step_created',
          correlationId: 'step_01ORPHAN',
          eventId: 'evnt_ORPHAN',
          eventData: { stepName: 'step//test//other' },
        }),
      ];
      const err = findReplayDivergence(
        events,
        view([{ correlationId: 'step_01AAAA', type: 'step' }])
      );
      expect(err).not.toBeNull();
      expect(err?.name).toBe('ReplayDivergenceError');
      expect(err?.message).toContain('Replay could not consume event');
      expect(err?.message).toContain('step_01ORPHAN');
      expect(err?.eventId).toBe('evnt_ORPHAN');
    });

    it('reports an attr_set written by the workflow for an unknown id', () => {
      const events = [
        makeEvent({
          eventType: 'attr_set',
          correlationId: 'attr_01ORPHAN',
          eventData: { changes: {}, writer: { type: 'workflow' } },
        }),
      ];
      expect(findReplayDivergence(events, view([]))).not.toBeNull();
    });

    it('accepts a hook event whose id is only known to the hook machinery', () => {
      const events = [
        makeEvent({
          eventType: 'hook_received',
          correlationId: 'hook_01AAAA',
          eventData: {},
        }),
      ];
      expect(
        findReplayDivergence(events, view([], { hookCids: ['hook_01AAAA'] }))
      ).toBeNull();
      expect(
        findReplayDivergence(events, view([], { abortCids: ['hook_01AAAA'] }))
      ).toBeNull();
    });

    it('returns the FIRST divergence in log order', () => {
      const events = [
        makeEvent({
          eventType: 'wait_created',
          correlationId: 'wait_01FIRST',
          eventId: 'evnt_FIRST',
        }),
        makeEvent({
          eventType: 'step_created',
          correlationId: 'step_01SECOND',
          eventId: 'evnt_SECOND',
        }),
      ];
      const err = findReplayDivergence(events, view([]));
      expect(err?.eventId).toBe('evnt_FIRST');
    });
  });

  describe('family mismatches', () => {
    it('reports a step event for an id the replay drew as a wait', () => {
      const events = [
        makeEvent({
          eventType: 'step_completed',
          correlationId: 'wait_01AAAA',
          eventData: { result: 1 },
        }),
      ];
      const err = findReplayDivergence(
        events,
        view([{ correlationId: 'wait_01AAAA', type: 'wait' }])
      );
      expect(err?.message).toContain('does not match');
    });

    it('accepts hook_disposed claimed by a hook_dispose op sharing the hook id', () => {
      const events = [
        makeEvent({
          eventType: 'hook_disposed',
          correlationId: 'hook_01AAAA',
        }),
      ];
      expect(
        findReplayDivergence(
          events,
          view([
            { correlationId: 'hook_01AAAA', type: 'hook', token: 't' },
            { correlationId: 'hook_01AAAA', type: 'hook_dispose' },
          ])
        )
      ).toBeNull();
    });
  });

  describe('identity mismatches', () => {
    const stepOp: VmKnownOp = {
      correlationId: 'step_01AAAA',
      type: 'step',
      stepId: 'step//test//releaseStep',
    };

    it('reports a step event recorded for a different step function', () => {
      const events = [
        makeEvent({
          eventType: 'step_created',
          correlationId: 'step_01AAAA',
          eventData: { stepName: 'step//test//recoverStep' },
        }),
      ];
      const err = findReplayDivergence(events, view([stepOp]));
      expect(err?.message).toContain('belongs to "step//test//recoverStep"');
      expect(err?.message).toContain(
        'current step consumer is "step//test//releaseStep"'
      );
    });

    it('accepts a step event with the matching stepName', () => {
      const events = [
        makeEvent({
          eventType: 'step_created',
          correlationId: 'step_01AAAA',
          eventData: { stepName: 'step//test//releaseStep' },
        }),
      ];
      expect(findReplayDivergence(events, view([stepOp]))).toBeNull();
    });

    it('accepts a step event that does not carry a stepName', () => {
      const events = [
        makeEvent({
          eventType: 'step_completed',
          correlationId: 'step_01AAAA',
          eventData: { result: 42 },
        }),
      ];
      expect(findReplayDivergence(events, view([stepOp]))).toBeNull();
    });

    it('reports a hook event recorded under a different token', () => {
      const events = [
        makeEvent({
          eventType: 'hook_created',
          correlationId: 'hook_01AAAA',
          eventData: { token: 'other-token' },
        }),
      ];
      const err = findReplayDivergence(
        events,
        view([{ correlationId: 'hook_01AAAA', type: 'hook', token: 'mine' }])
      );
      expect(err?.message).toContain('belongs to token "other-token"');
    });

    it('accepts a hook event with the matching token', () => {
      const events = [
        makeEvent({
          eventType: 'hook_created',
          correlationId: 'hook_01AAAA',
          eventData: { token: 'mine' },
        }),
      ];
      expect(
        findReplayDivergence(
          events,
          view([{ correlationId: 'hook_01AAAA', type: 'hook', token: 'mine' }])
        )
      ).toBeNull();
    });

    it('reports a wait_completed with a different resumeAt', () => {
      const events = [
        makeEvent({
          eventType: 'wait_completed',
          correlationId: 'wait_01AAAA',
          eventData: { resumeAt: '2025-01-01T00:01:00.000Z' },
        }),
      ];
      const err = findReplayDivergence(
        events,
        view([
          {
            correlationId: 'wait_01AAAA',
            type: 'wait',
            resumeAt: '2025-01-01T00:02:00.000Z',
          },
        ])
      );
      expect(err?.message).toContain('resumeAt');
    });

    it('accepts a wait_completed with the matching resumeAt (and one without eventData)', () => {
      const ops = [
        {
          correlationId: 'wait_01AAAA',
          type: 'wait',
          resumeAt: '2025-01-01T00:01:00.000Z',
        },
      ];
      expect(
        findReplayDivergence(
          [
            makeEvent({
              eventType: 'wait_completed',
              correlationId: 'wait_01AAAA',
              eventData: { resumeAt: '2025-01-01T00:01:00.000Z' },
            }),
          ],
          view(ops)
        )
      ).toBeNull();
      // The entrypoint's elapsed-wait pass writes wait_completed without
      // eventData — nothing to validate, must be accepted.
      expect(
        findReplayDivergence(
          [
            makeEvent({
              eventType: 'wait_completed',
              correlationId: 'wait_01AAAA',
              eventData: undefined,
            }),
          ],
          view(ops)
        )
      ).toBeNull();
    });
  });

  it('accepts a fully reproduced log', () => {
    const events = [
      makeEvent({ eventType: 'run_created', correlationId: 'wrun_test' }),
      makeEvent({ eventType: 'run_started', correlationId: 'wrun_test' }),
      makeEvent({
        eventType: 'hook_created',
        correlationId: 'hook_01AAAA',
        eventData: { token: 't1' },
      }),
      makeEvent({
        eventType: 'step_created',
        correlationId: 'step_01AAAA',
        eventData: { stepName: 'step//test//add' },
      }),
      makeEvent({
        eventType: 'step_completed',
        correlationId: 'step_01AAAA',
        eventData: { result: 17 },
      }),
      makeEvent({
        eventType: 'wait_created',
        correlationId: 'wait_01AAAA',
      }),
      makeEvent({
        eventType: 'hook_received',
        correlationId: 'hook_01AAAA',
        eventData: { payload: 'x' },
      }),
    ];
    expect(
      findReplayDivergence(
        events,
        view([
          { correlationId: 'hook_01AAAA', type: 'hook', token: 't1' },
          {
            correlationId: 'step_01AAAA',
            type: 'step',
            stepId: 'step//test//add',
          },
          {
            correlationId: 'wait_01AAAA',
            type: 'wait',
            resumeAt: '2025-01-01T00:05:00.000Z',
          },
        ])
      )
    ).toBeNull();
  });
});
