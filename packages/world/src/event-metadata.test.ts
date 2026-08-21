import { describe, expect, it } from 'vitest';
import {
  entityEventClass,
  getEventDataPayloadField,
  getEventDataRefFields,
  isSealedNoopEvent,
} from './event-metadata.js';

describe('event metadata', () => {
  it('classifies mutually exclusive entity events', () => {
    expect(entityEventClass('step_completed')).toBe('step_terminal');
    expect(entityEventClass('step_failed')).toBe('step_terminal');
    expect(entityEventClass('run_completed')).toBeUndefined();
  });

  it('uses one payload-field mapping for singular and plural lookups', () => {
    expect(getEventDataRefFields('run_created')).toEqual(['input']);
    expect(getEventDataPayloadField('run_created')).toBe('input');
    expect(getEventDataRefFields('step_completed')).toEqual(['result']);
    expect(getEventDataPayloadField('step_completed')).toBe('result');
  });

  it('returns no metadata for unknown and inherited property names', () => {
    expect(getEventDataRefFields('unknown')).toEqual([]);
    expect(getEventDataPayloadField('unknown')).toBeUndefined();
    expect(getEventDataRefFields('constructor')).toEqual([]);
    expect(entityEventClass('toString')).toBeUndefined();
  });

  it('identifies sealed-log filler events without loading event schemas', () => {
    expect(isSealedNoopEvent({ eventType: 'noop' })).toBe(true);
    expect(isSealedNoopEvent({ eventType: 'run_started' })).toBe(false);
  });
});
