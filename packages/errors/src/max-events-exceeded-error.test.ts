import { describe, expect, it } from 'vitest';
import {
  formatErrorMessageWithDetails,
  MaxEventsExceededError,
} from './index.js';

describe('MaxEventsExceededError', () => {
  it('frames a QuickJS hint above the docs link', () => {
    const err = new MaxEventsExceededError(25_000, 25_000);
    const lines = err.message.split('\n');
    expect(lines[0]).toBe(
      'Workflow exceeded the maximum of 25000 events per run'
    );
    expect(lines[1]).toMatch(/^├▶ hint: .*WORKFLOW_VM=quickjs/);
    expect(lines.at(-1)).toBe(
      '╰▶ docs: https://workflow-sdk.dev/err/max-events-exceeded'
    );
    expect(err.name).toBe('MaxEventsExceededError');
    expect(err.eventCount).toBe(25_000);
    expect(err.limit).toBe(25_000);
    expect(MaxEventsExceededError.is(err)).toBe(true);
  });
});

describe('formatErrorMessageWithDetails', () => {
  it('returns the title alone without details', () => {
    expect(formatErrorMessageWithDetails('Boom', {})).toBe('Boom');
  });

  it('frames hint and docs', () => {
    expect(
      formatErrorMessageWithDetails('Boom', {
        hint: 'Do the thing.',
        slug: 'replay-timeout',
      })
    ).toBe(
      'Boom\n├▶ hint: Do the thing.\n╰▶ docs: https://workflow-sdk.dev/err/replay-timeout'
    );
  });
});
