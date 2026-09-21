import assert from 'node:assert/strict';
import test from 'node:test';

import { getTerminalDeploymentState } from './deployment-state.mjs';

test('returns terminal failure states from state', () => {
  assert.equal(
    getTerminalDeploymentState({ state: 'ERROR', readyState: 'BUILDING' }),
    'ERROR'
  );
  assert.equal(
    getTerminalDeploymentState({ state: 'CANCELED', readyState: 'QUEUED' }),
    'CANCELED'
  );
});

test('returns terminal failure states from readyState', () => {
  assert.equal(
    getTerminalDeploymentState({ state: 'BUILDING', readyState: 'ERROR' }),
    'ERROR'
  );
  assert.equal(
    getTerminalDeploymentState({ state: 'QUEUED', readyState: 'CANCELED' }),
    'CANCELED'
  );
});

test('does not classify retryable deployment states as terminal failures', () => {
  for (const state of ['QUEUED', 'INITIALIZING', 'BUILDING']) {
    assert.equal(
      getTerminalDeploymentState({ state, readyState: state }),
      undefined
    );
  }
});
