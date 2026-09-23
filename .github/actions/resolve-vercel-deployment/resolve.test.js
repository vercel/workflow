const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FatalError,
  applyOverrides,
  main,
  resolveTarget,
  selectDeployment,
  waitForDeployment,
} = require('./resolve.js');

const SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

function deployment(overrides = {}) {
  const { meta, ...rest } = overrides;
  return {
    uid: 'dpl_1',
    url: 'app-abc.labs.vercel.dev',
    inspectorUrl: 'https://vercel.com/team/app/1',
    source: 'git',
    target: null,
    readyState: 'READY',
    createdAt: 1,
    meta: { githubCommitSha: SHA, githubCommitRef: 'feature', ...meta },
    ...rest,
  };
}

function pullRequest(headRef, headSha = SHA) {
  return {
    pull_request: {
      head: { ref: headRef, sha: headSha },
      base: { ref: 'main', sha: BASE_SHA },
    },
  };
}

const previewTarget = { sha: SHA, branch: 'feature', environment: 'preview' };

test('pull requests resolve their head preview deployment', () => {
  assert.deepEqual(
    resolveTarget({
      eventName: 'pull_request',
      event: pullRequest('feature'),
    }),
    previewTarget
  );
});

test('changeset-release PRs resolve the production deployment of their base', () => {
  assert.deepEqual(
    resolveTarget({
      eventName: 'pull_request',
      event: pullRequest('changeset-release/main'),
    }),
    { sha: BASE_SHA, branch: 'main', environment: 'production' }
  );
});

test('pushes to main resolve production; other refs resolve preview', () => {
  assert.deepEqual(
    resolveTarget({ eventName: 'push', githubSha: SHA, githubRefName: 'main' }),
    { sha: SHA, branch: 'main', environment: 'production' }
  );
  assert.deepEqual(
    resolveTarget({
      eventName: 'workflow_dispatch',
      githubSha: SHA,
      githubRefName: 'feature',
    }),
    previewTarget
  );
});

test('overrides replace derived values and are validated', () => {
  assert.deepEqual(
    applyOverrides(previewTarget, {
      sha: BASE_SHA.toUpperCase(),
      environment: 'production',
    }),
    { sha: BASE_SHA, branch: 'feature', environment: 'production' }
  );
  assert.throws(
    () => applyOverrides(previewTarget, { sha: 'abc123' }),
    /full commit SHA/
  );
  assert.throws(
    () => applyOverrides(previewTarget, { environment: 'staging' }),
    /production" or "preview/
  );
});

test('selects only Git deployments and redeploys of the exact commit, branch, and environment', () => {
  const match = deployment({ uid: 'dpl_match' });
  const candidates = [
    deployment({ uid: 'dpl_cli', source: 'cli', createdAt: 9 }),
    deployment({
      uid: 'dpl_other_branch',
      meta: { githubCommitRef: 'feature-candidate-1' },
      createdAt: 9,
    }),
    deployment({ uid: 'dpl_production', target: 'production', createdAt: 9 }),
    deployment({
      uid: 'dpl_other_sha',
      meta: { githubCommitSha: BASE_SHA },
      createdAt: 9,
    }),
    match,
  ];
  assert.equal(selectDeployment(candidates, previewTarget), match);
  const redeploy = deployment({
    uid: 'dpl_redeploy',
    source: 'redeploy',
    createdAt: 2,
  });
  assert.equal(
    selectDeployment([...candidates, redeploy], previewTarget),
    redeploy
  );
  assert.equal(
    selectDeployment(candidates.slice(0, 4), previewTarget),
    undefined
  );
});

test('prefers the newest matching deployment', () => {
  const newer = deployment({ uid: 'dpl_new', createdAt: 2 });
  assert.equal(
    selectDeployment(
      [deployment({ uid: 'dpl_old', readyState: 'CANCELED' }), newer],
      previewTarget
    ),
    newer
  );
});

function respond(next) {
  if (next instanceof Error) {
    throw next;
  }
  return {
    ok: next.status === undefined || next.status < 400,
    status: next.status ?? 200,
    json: async () => next.body ?? { deployments: next.deployments ?? [] },
  };
}

// `responses` answer the per-commit deployment list, in order. `details` maps a
// deployment ID to its v13 record, and `history` is the branch's READY list.
function harness(responses, { details = {}, history = [] } = {}) {
  let clock = 0;
  const requests = [];
  const lookups = [];
  return {
    requests,
    lookups,
    options: {
      projectId: 'prj_1',
      teamId: 'team_1',
      token: 'secret',
      target: previewTarget,
      timeoutMs: 60_000,
      intervalMs: 15_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: () => {},
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        if (url.pathname.startsWith('/v13/deployments/')) {
          lookups.push(url);
          const uid = decodeURIComponent(url.pathname.split('/').at(-1));
          return respond({ body: details[uid] ?? {} });
        }
        if (url.searchParams.has('branch')) {
          lookups.push(url);
          return respond({ deployments: history });
        }
        requests.push({ url, init });
        return respond(responses.shift());
      },
    },
  };
}

test('polls until the deployment is ready, tolerating transient failures', async () => {
  const { options, requests } = harness([
    { deployments: [] },
    new Error('socket hang up'),
    { status: 503 },
    { status: 429 },
    { deployments: [deployment({ readyState: 'BUILDING' })] },
    { deployments: [deployment()] },
  ]);
  options.timeoutMs = 120_000;
  const result = await waitForDeployment(options);
  assert.equal(result.uid, 'dpl_1');
  assert.equal(requests.length, 6);
  const { url, init } = requests[0];
  assert.equal(
    url.origin + url.pathname,
    'https://api.vercel.com/v6/deployments'
  );
  assert.equal(url.searchParams.get('projectId'), 'prj_1');
  assert.equal(url.searchParams.get('teamId'), 'team_1');
  assert.equal(url.searchParams.get('sha'), SHA);
  assert.equal(init.headers.authorization, 'Bearer secret');
});

test('fails immediately when the deployment errors', async () => {
  const { options, requests } = harness([
    { deployments: [deployment({ readyState: 'ERROR' })] },
  ]);
  await assert.rejects(waitForDeployment(options), (error) => {
    assert.ok(error instanceof FatalError);
    assert.match(error.message, /dpl_1 failed to build/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('fails immediately on authorization errors', async () => {
  const { options } = harness([{ status: 403 }]);
  await assert.rejects(waitForDeployment(options), /returned 403/);
});

test('waits for a redeploy after a canceled build, then times out', async () => {
  const canceled = { deployments: [deployment({ readyState: 'CANCELED' })] };
  const { options, requests } = harness(Array(10).fill(canceled));
  await assert.rejects(
    waitForDeployment(options),
    /canceled and not redeployed/
  );
  assert.equal(requests.length, 5);
});

test('a redeploy replaces a canceled build', async () => {
  const { options } = harness([
    { deployments: [deployment({ readyState: 'CANCELED' })] },
    {
      deployments: [
        deployment({ readyState: 'CANCELED' }),
        deployment({ uid: 'dpl_2', createdAt: 2 }),
      ],
    },
  ]);
  assert.equal((await waitForDeployment(options)).uid, 'dpl_2');
});

test('a skipped build resolves to the branch deployment it left serving', async () => {
  const skipped = deployment({
    uid: 'dpl_skipped',
    readyState: 'CANCELED',
    createdAt: 10,
  });
  const serving = deployment({
    uid: 'dpl_serving',
    createdAt: 5,
    meta: { githubCommitSha: BASE_SHA },
  });
  const { options, lookups } = harness([{ deployments: [skipped] }], {
    details: { dpl_skipped: { buildSkipped: true } },
    history: [
      deployment({
        uid: 'dpl_later',
        createdAt: 11,
        meta: { githubCommitSha: BASE_SHA },
      }),
      deployment({
        uid: 'dpl_other_branch',
        createdAt: 6,
        meta: { githubCommitRef: 'other', githubCommitSha: BASE_SHA },
      }),
      deployment({
        uid: 'dpl_older',
        createdAt: 1,
        meta: { githubCommitSha: BASE_SHA },
      }),
      serving,
    ],
  });
  assert.equal((await waitForDeployment(options)).uid, 'dpl_serving');
  const branchQuery = lookups.find((url) => url.searchParams.has('branch'));
  assert.equal(branchQuery.searchParams.get('branch'), 'feature');
  assert.equal(branchQuery.searchParams.get('state'), 'READY');
  assert.equal(branchQuery.searchParams.has('target'), false);
});

test('a skipped production build queries production deployments', async () => {
  const productionTarget = {
    sha: SHA,
    branch: 'main',
    environment: 'production',
  };
  const meta = { githubCommitRef: 'main' };
  const { options, lookups } = harness(
    [
      {
        deployments: [
          deployment({
            uid: 'dpl_skipped',
            target: 'production',
            readyState: 'CANCELED',
            createdAt: 10,
            meta,
          }),
        ],
      },
    ],
    {
      details: {
        dpl_skipped: {
          errorLink:
            'https://vercel.com/docs/monorepos#skipping-unaffected-projects',
        },
      },
      history: [
        deployment({
          uid: 'dpl_prod',
          target: 'production',
          createdAt: 5,
          meta: { ...meta, githubCommitSha: BASE_SHA },
        }),
      ],
    }
  );
  options.target = productionTarget;
  assert.equal((await waitForDeployment(options)).uid, 'dpl_prod');
  const branchQuery = lookups.find((url) => url.searchParams.has('branch'));
  assert.equal(branchQuery.searchParams.get('target'), 'production');
});

test('a skipped build with nothing earlier on the branch fails', async () => {
  const { options } = harness(
    [
      {
        deployments: [
          deployment({ uid: 'dpl_skipped', readyState: 'CANCELED' }),
        ],
      },
    ],
    {
      details: {
        dpl_skipped: {
          buildSkipped: true,
          readyStateReason: 'Ignored Build Step',
        },
      },
    }
  );
  await assert.rejects(waitForDeployment(options), (error) => {
    assert.ok(error instanceof FatalError);
    assert.match(
      error.message,
      /skipped \(Ignored Build Step\) and feature has no earlier/
    );
    return true;
  });
});

test('times out when no deployment appears', async () => {
  const { options } = harness(Array(10).fill({ deployments: [] }));
  await assert.rejects(waitForDeployment(options), /last state: missing/);
});

test('main writes step outputs for the resolved deployment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-deployment-'));
  const eventPath = path.join(dir, 'event.json');
  const outputPath = path.join(dir, 'output');
  fs.writeFileSync(eventPath, JSON.stringify(pullRequest('feature')));
  const { options } = harness([{ deployments: [deployment()] }]);
  delete options.projectId;
  delete options.teamId;
  delete options.token;
  delete options.target;
  delete options.timeoutMs;
  delete options.intervalMs;
  const outputs = await main(
    {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      INPUT_PROJECT_ID: 'prj_1',
      INPUT_TEAM_ID: 'team_1',
      INPUT_TOKEN: 'secret',
      INPUT_TIMEOUT_SECONDS: '60',
      INPUT_INTERVAL_SECONDS: '15',
    },
    options
  );
  assert.deepEqual(outputs, {
    'deployment-id': 'dpl_1',
    'deployment-url': 'https://app-abc.labs.vercel.dev',
    'inspector-url': 'https://vercel.com/team/app/1',
    environment: 'preview',
    sha: SHA,
    branch: 'feature',
  });
  assert.equal(
    fs.readFileSync(outputPath, 'utf8'),
    [
      'deployment-id=dpl_1',
      'deployment-url=https://app-abc.labs.vercel.dev',
      'inspector-url=https://vercel.com/team/app/1',
      'environment=preview',
      `sha=${SHA}`,
      'branch=feature',
      '',
    ].join('\n')
  );
});
