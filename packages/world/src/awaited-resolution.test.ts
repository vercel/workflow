import { describe, expect, it } from 'vitest';
import {
  awaitedResolutionMessage,
  findAwaitedResolution,
  RESOLUTION_EVENT_TYPES,
  type ResolutionCandidate,
  resolvesAwaited,
} from './awaited-resolution.js';
import type { EventType } from './events.js';

const event = (
  eventType: EventType,
  correlationId?: string
): ResolutionCandidate => ({ eventType, correlationId });

describe('resolvesAwaited', () => {
  it('fences a resolution for an awaited id', () => {
    for (const eventType of RESOLUTION_EVENT_TYPES) {
      if (eventType === 'run_cancelled') continue;
      expect(
        resolvesAwaited(event(eventType, 'step_a'), new Set(['step_a']))
      ).toBe(true);
    }
  });

  it('lets a resolution for an id nobody awaits through', () => {
    // The user's own example: a poke hook delivered while a replay is blocked
    // on something else is a valid log, not a divergence.
    expect(
      resolvesAwaited(
        event('hook_received', 'hook_poke'),
        new Set(['step_settle'])
      )
    ).toBe(false);
  });

  it('lets non-resolution events through even for an awaited id', () => {
    for (const eventType of [
      'step_created',
      'step_started',
      'step_retrying',
      'wait_created',
      'hook_created',
      'attr_set',
      'hook_conflict',
    ] as const) {
      expect(
        resolvesAwaited(event(eventType, 'step_a'), new Set(['step_a']))
      ).toBe(false);
    }
  });

  it('fences run_cancelled whenever anything is awaited', () => {
    expect(resolvesAwaited(event('run_cancelled'), new Set(['step_a']))).toBe(
      true
    );
    expect(resolvesAwaited(event('run_cancelled'), new Set())).toBe(false);
  });

  it('lets a resolution with no correlation id through', () => {
    expect(resolvesAwaited(event('step_completed'), new Set(['step_a']))).toBe(
      false
    );
  });
});

describe('findAwaitedResolution', () => {
  const skipped = [
    event('step_created', 'step_b'),
    event('hook_received', 'hook_poke'),
    event('step_completed', 'step_settle'),
    event('step_failed', 'step_other'),
  ];

  it('returns the first offending event, ignoring what precedes it', () => {
    expect(findAwaitedResolution(skipped, ['step_settle'])).toBe(skipped[2]);
  });

  it('returns undefined when nothing in the skipped span is awaited', () => {
    expect(findAwaitedResolution(skipped, ['step_untouched'])).toBeUndefined();
  });

  it('returns undefined for an empty awaited set without scanning', () => {
    expect(findAwaitedResolution(skipped, [])).toBeUndefined();
  });

  it('accepts any iterable of ids', () => {
    expect(findAwaitedResolution(skipped, new Set(['step_other']))).toBe(
      skipped[3]
    );
  });
});

describe('awaitedResolutionMessage', () => {
  it('names the event and the id it settles', () => {
    expect(
      awaitedResolutionMessage(event('step_completed', 'step_settle'))
    ).toContain('step_completed for step_settle');
  });

  it('omits the target for a run-wide resolution', () => {
    const message = awaitedResolutionMessage(event('run_cancelled'));
    expect(message).toContain('run_cancelled');
    expect(message).not.toContain(' for ');
  });
});
