const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PROJECT, verify } = require('./verify-vercel-deployment-dispatch.js');

const SHA = '1234567890abcdef1234567890abcdef12345678';

function payload(overrides = {}) {
  return {
    environment: 'preview',
    git: { ref: 'feature', sha: SHA, shortSha: SHA.slice(0, 7) },
    id: 'dpl_test',
    project: PROJECT,
    state: { type: 'success' },
    url: 'https://example-nextjs-workflow-turbopack-test.labs.vercel.dev',
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    id: 'dpl_test',
    inspectorUrl: 'https://vercel.com/vercel-labs/project/dpl_test',
    name: PROJECT.name,
    projectId: PROJECT.id,
    readyState: 'READY',
    source: 'git',
    target: null,
    url: 'example-nextjs-workflow-turbopack-test.labs.vercel.dev',
    meta: {
      githubCommitOrg: 'vercel',
      githubCommitRepo: 'workflow',
      githubCommitRef: 'feature',
      githubCommitSha: SHA,
    },
    ...overrides,
  };
}

test('returns deployment identity after exact verification', () => {
  assert.deepEqual(verify({ payload: payload(), deployment: deployment() }), {
    deploymentId: 'dpl_test',
    deploymentUrl:
      'https://example-nextjs-workflow-turbopack-test.labs.vercel.dev/',
    inspectorUrl: 'https://vercel.com/vercel-labs/project/dpl_test',
    environment: 'preview',
    sha: SHA,
    ref: 'feature',
    projectId: PROJECT.id,
    projectName: PROJECT.name,
  });
});

test('accepts a matching production deployment', () => {
  const result = verify({
    payload: payload({
      environment: 'production',
      git: { ref: 'main', sha: SHA },
    }),
    deployment: deployment({
      target: 'production',
      meta: {
        githubCommitOrg: 'vercel',
        githubCommitRepo: 'workflow',
        githubCommitRef: 'main',
        githubCommitSha: SHA,
      },
    }),
  });
  assert.equal(result.environment, 'production');
  assert.equal(result.ref, 'main');
});

test('rejects mismatched deployment identity', () => {
  assert.throws(
    () =>
      verify({
        payload: payload(),
        deployment: deployment({
          projectId: 'prj_wrong',
          readyState: 'ERROR',
          url: 'wrong.example.com',
        }),
      }),
    /projectId.*deploymentUrl|projectId.*url|repository dispatch does not match/
  );
});

test('rejects non-Git or foreign-repository deployments', () => {
  assert.throws(
    () =>
      verify({
        payload: payload(),
        deployment: deployment({
          source: 'cli',
          meta: {
            githubCommitOrg: 'attacker',
            githubCommitRepo: 'fork',
            githubCommitRef: 'feature',
            githubCommitSha: SHA,
          },
        }),
      }),
    /deployment.source/
  );
});
