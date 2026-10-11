const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_SLOTS,
  MAX_SLOTS,
  pickSlot,
  resolveSlots,
  run,
} = require('./pick-e2e-slot.js');

test('the repo-wide cap is one run of Vercel E2E, and at most two', () => {
  // These two numbers are the cap. A change to either is a change to how
  // much Vercel E2E traffic CI can have in flight repo-wide, so it should
  // fail here and be argued for in review rather than drift silently.
  assert.equal(DEFAULT_SLOTS, 1);
  assert.equal(MAX_SLOTS, 2);
});

test('an unset or blank variable uses the default', () => {
  for (const raw of [undefined, '', '   ']) {
    assert.deepEqual(resolveSlots(raw), {
      slots: DEFAULT_SLOTS,
      warning: null,
    });
  }
});

test('a value within range is used as written', () => {
  assert.deepEqual(resolveSlots('2'), { slots: 2, warning: null });
  assert.deepEqual(resolveSlots(' 2 '), { slots: 2, warning: null });
});

test('a value above the ceiling is clamped, not honoured', () => {
  // The failure mode this guards: the dial is meant to be tunable from
  // repository settings, but nothing there should be able to raise the peak
  // past what the matrices already fan out to.
  for (const raw of ['3', '10', '100']) {
    const { slots, warning } = resolveSlots(raw);
    assert.equal(slots, MAX_SLOTS);
    assert.match(warning, /clamping to 2/);
  }
});

test('zero is clamped to one slot rather than dividing by zero', () => {
  const { slots, warning } = resolveSlots('0');
  assert.equal(slots, 1);
  assert.match(warning, /clamping to 1/);
  assert.equal(pickSlot({ slots, runId: 123 }), 0);
});

test('a malformed value falls back to the default with a warning', () => {
  for (const raw of ['two', '1.5', '-1', '2x', '']) {
    const { slots } = resolveSlots(raw);
    assert.equal(slots, DEFAULT_SLOTS);
  }
  assert.match(resolveSlots('two').warning, /not a whole number/);
  // '-1' is malformed rather than "below 1": the regex rejects the sign.
  assert.match(resolveSlots('-1').warning, /not a whole number/);
  assert.equal(resolveSlots('').warning, null);
});

test('the slot is the run id modulo the slot count', () => {
  assert.equal(pickSlot({ slots: 2, runId: 10 }), 0);
  assert.equal(pickSlot({ slots: 2, runId: 11 }), 1);
  assert.equal(pickSlot({ slots: 2, runId: '17654321987' }), 1);
});

test('one slot puts every run in the same group', () => {
  for (const runId of [1, 2, 3, 99, 17654321987]) {
    assert.equal(pickSlot({ slots: 1, runId }), 0);
  }
});

test('a re-run of the same run keeps its slot', () => {
  const runId = 17654321986;
  assert.equal(
    pickSlot({ slots: 2, runId }),
    pickSlot({ slots: 2, runId: String(runId) })
  );
});

test('a missing or unusable run id lands in slot 0', () => {
  for (const runId of [undefined, '', 'not-a-number', -5, Number.NaN]) {
    assert.equal(pickSlot({ slots: 2, runId }), 0);
  }
});

test('the script emits a single GITHUB_OUTPUT line', () => {
  const { output, slot, slots, warning } = run({
    GITHUB_RUN_ID: '17654321987',
  });
  assert.equal(slots, DEFAULT_SLOTS);
  assert.equal(slot, 0);
  assert.equal(warning, null);
  assert.equal(output, 'slot=0\n');
});

test('the script honours the variable when it is in range', () => {
  const { output, slot, slots } = run({
    E2E_VERCEL_CONCURRENCY_SLOTS: '2',
    GITHUB_RUN_ID: '17654321987',
  });
  assert.equal(slots, 2);
  assert.equal(slot, 1);
  assert.equal(output, 'slot=1\n');
});
