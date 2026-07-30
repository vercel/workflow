import {
  FIRST_SLOT,
  SLOT_ID_WIDTH,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SLOT_IDENTITY,
  slotFromId,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { createCorrelationIdFactory } from './correlation-ids.js';

/** Stands in for the invocation's seeded, replay-stable ULID generator. */
function fakeUlids(): () => string {
  let issued = 0;
  return () => `01ULID${String(++issued).padStart(20, '0')}`;
}

function slotFactory() {
  return createCorrelationIdFactory({
    specVersion: SPEC_VERSION_SLOT_IDENTITY,
    generateUlid: fakeUlids(),
  });
}

describe('createCorrelationIdFactory', () => {
  describe('slot identity', () => {
    it('numbers each kind densely from the first slot', () => {
      const next = slotFactory();
      expect(slotFromId(next('step'))).toBe(FIRST_SLOT);
      expect(slotFromId(next('step'))).toBe(FIRST_SLOT + 1);
      expect(slotFromId(next('wait'))).toBe(FIRST_SLOT);
    });

    it('keeps the prefix of the kind it was asked for', () => {
      const next = slotFactory();
      expect(next('step')).toMatch(
        new RegExp(`^step_[0-9]{${SLOT_ID_WIDTH}}$`)
      );
      expect(next('wait')).toMatch(
        new RegExp(`^wait_[0-9]{${SLOT_ID_WIDTH}}$`)
      );
    });

    it('issues the same sequence to two fresh invocations', () => {
      // Replay stability: the VM is rebuilt per replay and the workflow body
      // issues its operations in the same order, so nothing needs seeding.
      const replay = () => {
        const next = slotFactory();
        return [next('step'), next('wait'), next('step'), next('step')];
      };
      expect(replay()).toEqual(replay());
    });

    it('does not renumber steps or waits when another kind allocates', () => {
      // Kinds that stay on ULIDs (hooks, attributes) draw from generateUlid,
      // and a per-kind counter means interleaving them cannot shift a step's
      // number — which a single shared sequence would.
      const ulids = fakeUlids();
      const next = createCorrelationIdFactory({
        specVersion: SPEC_VERSION_SLOT_IDENTITY,
        generateUlid: ulids,
      });
      const firstStep = next('step');
      ulids();
      ulids();
      const secondStep = next('step');
      expect(slotFromId(firstStep)).toBe(FIRST_SLOT);
      expect(slotFromId(secondStep)).toBe(FIRST_SLOT + 1);
      expect(slotFromId(next('wait'))).toBe(FIRST_SLOT);
    });
  });

  describe('ULID identity', () => {
    it('draws from the invocation generator for every kind', () => {
      const next = createCorrelationIdFactory({
        specVersion: SPEC_VERSION_CURRENT,
        generateUlid: fakeUlids(),
      });
      // One shared sequence, exactly as before slots existed: an id's number
      // reflects the order of allocation across all kinds.
      expect(next('step')).toBe('step_01ULID00000000000000000001');
      expect(next('wait')).toBe('wait_01ULID00000000000000000002');
    });

    it('treats a run with no spec version as ULID-numbered', () => {
      const next = createCorrelationIdFactory({
        specVersion: undefined,
        generateUlid: fakeUlids(),
      });
      expect(slotFromId(next('step'))).toBeUndefined();
    });
  });
});
