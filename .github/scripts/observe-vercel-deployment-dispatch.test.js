const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  OBSERVED_PROJECT,
  normalizeDeploymentDispatch,
  main,
} = require('./observe-vercel-deployment-dispatch.js');

const SHA = '1234567890abcdef1234567890abcdef12345678';

function successPayload() {
  return {
    environment: 'preview',
    git: {
      ref: 'alangenfeld/example',
      sha: SHA,
      shortSha: SHA.slice(0, 7),
    },
    id: 'dpl_1234567890abcdefghijklmnopqrstuvwxyz',
    project: { ...OBSERVED_PROJECT },
    state: { type: 'success' },
    url: 'https://example-nextjs-workflow-turbopack-abc.labs.vercel.dev',
  };
}

function normalize(eventType, payload = successPayload()) {
  return normalizeDeploymentDispatch({
    eventType,
    payload,
    observedAt: '2026-09-21T00:00:00.000Z',
    run: {
      repository: 'vercel/workflow',
      id: '1234',
      attempt: '1',
      url: 'https://github.com/vercel/workflow/actions/runs/1234',
    },
  });
}

test('normalizes a successful deployment event', () => {
  assert.deepEqual(normalize('vercel.deployment.success'), {
    schemaVersion: 1,
    source: 'vercel-repository-dispatch',
    observedAt: '2026-09-21T00:00:00.000Z',
    eventType: 'vercel.deployment.success',
    project: OBSERVED_PROJECT,
    deployment: {
      id: 'dpl_1234567890abcdefghijklmnopqrstuvwxyz',
      url: 'https://example-nextjs-workflow-turbopack-abc.labs.vercel.dev/',
      environment: 'preview',
      state: { type: 'success' },
    },
    git: {
      ref: 'alangenfeld/example',
      sha: SHA,
      shortSha: SHA.slice(0, 7),
    },
    github: {
      repository: 'vercel/workflow',
      runId: '1234',
      runAttempt: '1',
      runUrl: 'https://github.com/vercel/workflow/actions/runs/1234',
    },
  });
});

test('redacts error event diagnostics', () => {
  const payload = successPayload();
  delete payload.id;
  delete payload.url;
  payload.state = { type: 'failed', detail: 'checks_failed' };
  payload.error = 'internal-host.example: sensitive diagnostic';

  const record = normalize('vercel.deployment.failed', payload);
  assert.deepEqual(record.deployment, {
    environment: 'preview',
    state: { type: 'failed', detail: 'checks_failed' },
    errorPresent: true,
  });
  assert.doesNotMatch(JSON.stringify(record), /internal-host|sensitive/);
});

test('rejects events for another project', () => {
  const payload = successPayload();
  payload.project.id = 'prj_other';
  assert.throws(
    () => normalize('vercel.deployment.success', payload),
    /unexpected project/
  );
});

test('rejects a mismatch between the event type and payload state', () => {
  assert.throws(
    () => normalize('vercel.deployment.error'),
    /does not match client_payload.state.type/
  );
});

test('rejects successful events without deployment identity', () => {
  const payload = successPayload();
  delete payload.id;
  assert.throws(
    () => normalize('vercel.deployment.success', payload),
    /must include id and url/
  );
});

test('requires a documented failure detail', () => {
  const payload = successPayload();
  payload.state = { type: 'failed' };
  assert.throws(
    () => normalize('vercel.deployment.failed', payload),
    /detail is required for failed events/
  );
});

test('rejects invalid or forbidden state details', () => {
  const failed = successPayload();
  failed.state = { type: 'failed', detail: 'unknown_failure' };
  assert.throws(
    () => normalize('vercel.deployment.failed', failed),
    /detail unknown_failure is not valid for failed events/
  );

  const canceled = successPayload();
  canceled.state = { type: 'canceled', detail: 'checks_failed' };
  assert.throws(
    () => normalize('vercel.deployment.canceled', canceled),
    /detail checks_failed is not valid for canceled events/
  );
});

test('accepts documented optional details', () => {
  const success = successPayload();
  success.state.detail = 'checks_skipped';
  assert.deepEqual(
    normalize('vercel.deployment.success', success).deployment.state,
    { type: 'success', detail: 'checks_skipped' }
  );

  const error = successPayload();
  error.state = { type: 'error', detail: 'deployment_deleted' };
  assert.deepEqual(
    normalize('vercel.deployment.error', error).deployment.state,
    { type: 'error', detail: 'deployment_deleted' }
  );
});

test('requires shortSha to match the full SHA', () => {
  const missing = successPayload();
  delete missing.git.shortSha;
  assert.throws(
    () => normalize('vercel.deployment.success', missing),
    /shortSha must be a non-empty string/
  );

  const mismatched = successPayload();
  mismatched.git.shortSha = 'abcdef0';
  assert.throws(
    () => normalize('vercel.deployment.success', mismatched),
    /shortSha must be the first 7 characters/
  );
});

test('normalizes a manual simulation event file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-observer-'));
  const eventPath = path.join(dir, 'event.json');
  const output = path.join(dir, 'observation.json');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      inputs: {
        event_type: 'vercel.deployment.success',
        client_payload: JSON.stringify(successPayload()),
      },
    })
  );

  const record = main(['--event-path', eventPath, '--output', output], {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'vercel/workflow',
    GITHUB_RUN_ID: '5678',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SERVER_URL: 'https://github.com',
    OBSERVED_AT: '2026-09-21T01:00:00.000Z',
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), record);
  assert.equal(record.github.runId, '5678');
  assert.equal(record.observedAt, '2026-09-21T01:00:00.000Z');
});
