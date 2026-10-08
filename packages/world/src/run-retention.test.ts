/**
 * The retention resolver is shared by every World that implements retention,
 * so its tests live with it rather than with any one World. Drift between two
 * hand-written parsers would mean one World deleting a run another keeps —
 * these cases are what stop that.
 */
import { describe, expect, it } from 'vitest';
import {
  purgesUserDataOnFinish,
  RETENTION_ATTRIBUTE,
  readRunRetention,
} from './attributes-validation.js';

const attrs = (value: string) => ({ [RETENTION_ATTRIBUTE]: value });

describe('readRunRetention', () => {
  it('purges only on the literal "0"', () => {
    expect(readRunRetention(attrs('0'))).toEqual({
      mode: 'none',
      raw: '0',
      unsupported: false,
      wellFormed: true,
    });
  });

  it('keeps the data when the attribute is absent', () => {
    expect(readRunRetention(undefined).mode).toBe('default');
    expect(readRunRetention({}).mode).toBe('default');
    expect(readRunRetention({ tenant: 't1' }).mode).toBe('default');
  });

  it('treats "default" as an explicit no-op rather than an unknown value', () => {
    expect(readRunRetention(attrs('default'))).toEqual({
      mode: 'default',
      raw: 'default',
      unsupported: false,
      wellFormed: false,
    });
  });

  // The failure mode that matters is deleting data nobody asked to delete, so
  // every value that is not exactly "0" has to land on 'default'. A non-zero
  // duration is singled out because it is the one an SDK will legitimately
  // start sending once the unit is decided: it must be *kept*, not guessed at.
  it.each([
    ['a non-zero duration', '7'],
    ['a large duration', '86400'],
    ['a malformed word', 'none'],
    ['a negative number', '-1'],
    ['a float', '0.0'],
    ['a zero with a unit', '0s'],
    ['a padded zero', ' 0 '],
    ['an empty string', ''],
    ['a leading-zero integer', '007'],
  ])('keeps the data for %s', (_label, value) => {
    const retention = readRunRetention(attrs(value));
    expect(retention.mode).toBe('default');
    expect(retention.unsupported).toBe(true);
    expect(retention.raw).toBe(value);
  });

  it('separates "a duration we cannot scale" from "a value we do not know"', () => {
    expect(readRunRetention(attrs('7')).wellFormed).toBe(true);
    expect(readRunRetention(attrs('none')).wellFormed).toBe(false);
  });
});

describe('purgesUserDataOnFinish', () => {
  it('is true only for the literal "0"', () => {
    expect(purgesUserDataOnFinish({ [RETENTION_ATTRIBUTE]: '0' })).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['empty attributes', {}],
    ['default', { [RETENTION_ATTRIBUTE]: 'default' }],
    ['a non-zero duration', { [RETENTION_ATTRIBUTE]: '7' }],
    ['a malformed word', { [RETENTION_ATTRIBUTE]: 'none' }],
    ['a padded zero', { [RETENTION_ATTRIBUTE]: ' 0 ' }],
    ['a suffixed zero', { [RETENTION_ATTRIBUTE]: '0s' }],
    ['a float zero', { [RETENTION_ATTRIBUTE]: '0.0' }],
    ['a signed zero', { [RETENTION_ATTRIBUTE]: '-0' }],
    ['a padded-digit zero', { [RETENTION_ATTRIBUTE]: '00' }],
  ])('is false for %s', (_label, attributes) => {
    // Every entry here is a value a lenient parser might read as zero. The
    // failure that matters is deleting data nobody asked to delete.
    expect(purgesUserDataOnFinish(attributes as never)).toBe(false);
  });
});
