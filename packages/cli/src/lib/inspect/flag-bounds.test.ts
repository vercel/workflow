import { describe, expect, it } from 'vitest';
import {
  validateAllScope,
  validateAttributeScope,
  validateInspectFlags,
  validateInspectLimit,
  validateInspectRunId,
  validateRunScope,
} from './flag-bounds.js';

describe('validateInspectLimit', () => {
  it.each([1, 20, 100])('accepts %s', (limit) => {
    expect(validateInspectLimit(limit)).toBeUndefined();
  });

  // 101-1000 used to be accepted here and rejected downstream: the cross-run
  // listings reject them locally, and the run-scoped ones take them as far as
  // a storage fallback that caps at 100 and answers with an opaque 400.
  it.each([
    0,
    -1,
    101,
    500,
    1001,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects %s and names the flag', (limit) => {
    expect(validateInspectLimit(limit)).toBe(
      '--limit must be an integer between 1 and 100.'
    );
  });
});

describe('validateInspectRunId', () => {
  it('accepts a well-formed run id', () => {
    expect(
      validateInspectRunId('wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE')
    ).toBeUndefined();
  });

  // The backend accepts neither of these, so catching them here saves a round
  // trip and names the flag.
  it.each([
    ['a lowercase body', 'wrun_01k4bzq5t2j8hxfm6wd3pnavce'],
    ['a first character above 7', 'wrun_81K4BZQ5T2J8HXFM6WD3PNAVCE'],
    ['a non-Crockford character', 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCI'],
    ['the wrong prefix', 'step_01K4BZQ5T2J8HXFM6WD3PNAVCE'],
    ['no prefix', '01K4BZQ5T2J8HXFM6WD3PNAVCE'],
    ['a truncated body', 'wrun_01K4BZQ'],
    ['nothing', ''],
  ])('rejects %s', (_label, runId) => {
    expect(validateInspectRunId(runId)).toContain('--runId must be a run id');
  });
});

describe('validateAttributeScope', () => {
  it('is undefined when the flag is absent, whatever the resource', () => {
    for (const resource of ['run', 'step', 'event', 'attribute', 'web']) {
      expect(validateAttributeScope(resource, false, false)).toBeUndefined();
      expect(validateAttributeScope(resource, true, false)).toBeUndefined();
    }
  });

  it('allows it on the runs listing', () => {
    expect(validateAttributeScope('run', false, true)).toBeUndefined();
  });

  // Every one of these parsed the flag and ignored it before. `web` is not
  // listed: the command always passes `opensWebUi` for it, so it is rejected
  // by that arm instead and this one is unreachable for that value.
  it.each([
    'step',
    'event',
    'hook',
    'sleep',
    'stream',
    'attribute',
  ])('rejects it on %s', (resource) => {
    expect(validateAttributeScope(resource, false, true)).toContain(
      '--attribute filters run listings only'
    );
  });

  // A single-run lookup already names its run, so there is nothing to filter.
  it('rejects it alongside a run ID', () => {
    expect(validateAttributeScope('run', true, true)).toContain(
      'already names one run'
    );
  });
});

describe('validateAttributeScope with the web UI', () => {
  // Both flags return before the filter is parsed or forwarded, so the view
  // opened unfiltered and a malformed pair was never checked.
  it.each([
    true,
    false,
  ])('rejects --attribute when handing off to the web UI (hasId=%s)', (hasId) => {
    expect(validateAttributeScope('run', hasId, true, true)).toContain(
      'cannot be forwarded to the web UI'
    );
  });

  it('still allows it for a local runs listing', () => {
    expect(validateAttributeScope('run', false, true, false)).toBeUndefined();
  });

  it('says nothing when the flag is absent', () => {
    expect(validateAttributeScope('run', false, false, true)).toBeUndefined();
  });
});

// The command calls this once, before any backend setup. It composes the
// three checks above with the `--attribute` parse, so a malformed pair and an
// out-of-range limit reach the user the same way.
describe('validateInspectFlags', () => {
  const base = { resource: 'run', hasId: false, opensWebUi: false };

  it('returns the parsed filters when everything checks out', () => {
    expect(
      validateInspectFlags({ ...base, attribute: ['tenant=acme'], limit: 50 })
    ).toEqual({ attributes: { tenant: 'acme' } });
  });

  it('leaves attributes undefined when the flag was not given', () => {
    expect(validateInspectFlags(base)).toEqual({ attributes: undefined });
  });

  it('reports a malformed pair rather than throwing', () => {
    const result = validateInspectFlags({ ...base, attribute: ['tenant'] });
    expect(result).toHaveProperty('error');
  });

  // Order matters: a bound that fails should be reported before the parse
  // runs, so the message names the flag the caller can act on first.
  it.each([
    ['limit', { limit: 500 }, '--limit must be an integer'],
    ['runId', { runId: 'nope' }, '--runId must be a run id'],
    [
      'scope',
      { resource: 'step', attribute: ['a=b'] },
      '--attribute filters run listings only',
    ],
    [
      'withData',
      { attribute: ['a=b'], withData: true },
      'cannot be combined with --withData',
    ],
    [
      'web UI',
      { attribute: ['a=b'], opensWebUi: true },
      'cannot be forwarded to the web UI',
    ],
  ])('reports a bad %s', (_label, flags, expected) => {
    const result = validateInspectFlags({ ...base, ...flags });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain(expected);
  });
});

describe('validateAllScope', () => {
  it('is undefined when the flag is absent', () => {
    for (const resource of ['run', 'step', 'event', 'hook', 'web']) {
      expect(validateAllScope(resource, false, false)).toBeUndefined();
    }
  });

  it.each([
    'step',
    'event',
    'sleep',
  ])('allows it on the %s listing', (resource) => {
    expect(validateAllScope(resource, false, true)).toBeUndefined();
  });

  // These listings already print their cursor in JSON. Accepting --all and
  // reading one page would be a silent drop.
  it.each([
    'run',
    'hook',
    'attribute',
    'stream',
  ])('rejects it on %s', (resource) => {
    expect(validateAllScope(resource, false, true)).toContain(
      '--all pages through the steps, events, and sleeps listings'
    );
  });

  it('rejects it alongside an ID', () => {
    expect(validateAllScope('step', true, true)).toContain('names one item');
  });

  it('rejects it with --interactive', () => {
    expect(validateAllScope('event', false, true, true)).toContain(
      'drop --interactive'
    );
  });

  it('rejects it when handing off to the web UI', () => {
    expect(validateAllScope('event', false, true, false, true)).toContain(
      'cannot be forwarded to the web UI'
    );
  });

  it('is part of validateInspectFlags', () => {
    expect(
      validateInspectFlags({
        resource: 'run',
        hasId: false,
        opensWebUi: false,
        all: true,
      })
    ).toHaveProperty('error');
    expect(
      validateInspectFlags({
        resource: 'event',
        hasId: false,
        opensWebUi: false,
        all: true,
      })
    ).toEqual({ attributes: undefined });
  });
});

describe('validateRunScope', () => {
  it('rejects a stream ID without --runId', () => {
    expect(validateRunScope('stream', true, false)).toContain(
      'a stream name is scoped to its run'
    );
  });

  it('rejects an event ID without --runId', () => {
    expect(validateRunScope('event', true, false)).toContain(
      'an event id names a slot in its run'
    );
  });

  it.each([
    ['with --runId', 'stream', true, true, false],
    ['for an event ID with --runId', 'event', true, true, false],
    ['for the events listing', 'event', false, false, false],
    ['for the streams listing', 'stream', false, false, false],
    ['for a web deep link', 'stream', true, false, true],
    ['for a hook ID', 'hook', true, false, false],
    ['for a run ID', 'run', true, false, false],
  ])('allows it %s', (_label, resource, hasId, hasRunId, opensWebUi) => {
    expect(
      validateRunScope(resource, hasId, hasRunId, opensWebUi)
    ).toBeUndefined();
  });
});
