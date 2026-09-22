const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const PROJECT = {
  id: 'prj_yjkM7UdHliv8bfxZ1sMJQf1pMpdi',
  name: 'example-nextjs-workflow-turbopack',
};
const OBSERVATION_STARTED_AT = Date.parse('2026-09-22T16:11:01Z');
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function timestamp(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${field} must be a positive timestamp`);
  }
  return number;
}

function deploymentState(value) {
  const state = String(value || '').toUpperCase();
  if (state === 'READY') return 'success';
  if (state === 'ERROR') return 'error';
  if (state === 'CANCELED') return 'canceled';
  return undefined;
}

function deploymentEnvironment(deployment) {
  return deployment.target === 'production' ? 'production' : 'preview';
}

function normalizeDeployment(deployment) {
  if (deployment.source !== 'git') return undefined;
  const id = requiredString(deployment.uid || deployment.id, 'deployment.uid');
  const state = deploymentState(deployment.readyState || deployment.state);
  if (!state) return undefined;
  const terminalAt = timestamp(
    deployment.ready || deployment.readyAt || deployment.updatedAt,
    `deployment ${id} terminal timestamp`
  );
  return {
    id,
    project: PROJECT,
    url: `https://${requiredString(deployment.url, `deployment ${id} url`)}`,
    environment: deploymentEnvironment(deployment),
    state,
    terminalAt: new Date(terminalAt).toISOString(),
    git: {
      sha: requiredString(
        deployment.meta?.githubCommitSha,
        `deployment ${id} git SHA`
      ).toLowerCase(),
      ref: requiredString(
        deployment.meta?.githubCommitRef,
        `deployment ${id} git ref`
      ),
    },
  };
}

function percentile(values, percentage) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((percentage / 100) * sorted.length) - 1];
}

function compareObservation(deployment, observation) {
  const mismatches = [];
  const compare = (field, expected, actual) => {
    if (expected !== actual) mismatches.push({ field, expected, actual });
  };
  compare('project.id', deployment.project.id, observation.project?.id);
  compare('project.name', deployment.project.name, observation.project?.name);
  compare(
    'deployment.environment',
    deployment.environment,
    observation.deployment?.environment
  );
  compare(
    'deployment.state.type',
    deployment.state,
    observation.deployment?.state?.type
  );
  compare('git.sha', deployment.git.sha, observation.git?.sha);
  compare('git.ref', deployment.git.ref, observation.git?.ref);
  return mismatches;
}

function groupObservations(observations) {
  const byDeployment = new Map();
  const unmatchable = [];
  for (const observation of observations) {
    const deploymentId = observation.deployment?.id;
    if (!deploymentId) {
      unmatchable.push({
        runId: observation.github?.runId,
        reason: 'missing deployment id',
      });
      continue;
    }
    const entries = byDeployment.get(deploymentId) || [];
    entries.push(observation);
    byDeployment.set(deploymentId, entries);
  }
  return { byDeployment, unmatchable };
}

function analyzeObservedDeployment(deployment, observations, runById) {
  const runIds = observations.map((entry) => entry.github?.runId);
  const mismatched = [];
  const latencies = [];
  for (const observation of observations) {
    const differences = compareObservation(deployment, observation);
    if (differences.length > 0) {
      mismatched.push({
        deploymentId: deployment.id,
        runId: observation.github?.runId,
        differences,
      });
    }
    const run = runById.get(String(observation.github?.runId));
    const observedAt = Date.parse(run?.createdAt || observation.observedAt);
    if (Number.isFinite(observedAt)) {
      latencies.push(
        Math.max(0, observedAt - Date.parse(deployment.terminalAt))
      );
    }
  }
  return {
    matched: { deploymentId: deployment.id, runIds },
    duplicate:
      observations.length > 1
        ? { deploymentId: deployment.id, runIds }
        : undefined,
    mismatched,
    latencies,
  };
}

function reconcile({
  deployments,
  observations,
  runs,
  downloadFailures = [],
  from,
  to,
}) {
  const effectiveFrom = Math.max(from, OBSERVATION_STARTED_AT);
  const normalizedDeployments = deployments
    .map(normalizeDeployment)
    .filter(Boolean)
    .filter((deployment) => {
      const terminalAt = Date.parse(deployment.terminalAt);
      return terminalAt >= effectiveFrom && terminalAt <= to;
    });
  const runById = new Map(runs.map((run) => [String(run.databaseId), run]));
  const grouped = groupObservations(observations);
  const deploymentIds = new Set(
    normalizedDeployments.map((deployment) => deployment.id)
  );
  const missing = [];
  const duplicates = [];
  const mismatched = [];
  const matched = [];
  const latencies = [];

  for (const deployment of normalizedDeployments) {
    const entries = grouped.byDeployment.get(deployment.id) || [];
    if (entries.length === 0) {
      missing.push(deployment);
      continue;
    }
    const analysis = analyzeObservedDeployment(deployment, entries, runById);
    matched.push(analysis.matched);
    if (analysis.duplicate) duplicates.push(analysis.duplicate);
    mismatched.push(...analysis.mismatched);
    latencies.push(...analysis.latencies);
  }

  const unexpected = [...grouped.byDeployment.entries()]
    .filter(([deploymentId]) => !deploymentIds.has(deploymentId))
    .map(([deploymentId, entries]) => ({
      deploymentId,
      runIds: entries.map((entry) => entry.github?.runId),
    }));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    window: {
      from: new Date(effectiveFrom).toISOString(),
      to: new Date(to).toISOString(),
    },
    project: PROJECT,
    counts: {
      deployments: normalizedDeployments.length,
      observed: matched.length,
      missing: missing.length,
      duplicate: duplicates.length,
      mismatched: mismatched.length,
      unexpected: unexpected.length,
      unmatchable: grouped.unmatchable.length,
      artifactDownloadFailures: downloadFailures.length,
    },
    latencyMs: {
      samples: latencies.length,
      ...(latencies.length > 0
        ? {
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            max: Math.max(...latencies),
          }
        : {}),
    },
    missing,
    duplicates,
    mismatched,
    unexpected,
    unmatchable: grouped.unmatchable,
    artifactDownloadFailures: downloadFailures,
  };
}

function findFiles(root, filename) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const location = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...findFiles(location, filename));
    if (entry.isFile() && entry.name === filename) files.push(location);
  }
  return files;
}

function loadObservations(root) {
  return findFiles(root, 'vercel-deployment-dispatch-observation.json').map(
    (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
  );
}

function renderMarkdown(report) {
  const value = (number) => (number === undefined ? '—' : `${number} ms`);
  const lines = [
    '## Vercel deployment dispatch reconciliation',
    '',
    `Window: ${report.window.from} → ${report.window.to}`,
    '',
    '| Deployments | Observed | Missing | Duplicates | Mismatched | Unexpected | Unmatchable | Artifact errors |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${report.counts.deployments} | ${report.counts.observed} | ${report.counts.missing} | ${report.counts.duplicate} | ${report.counts.mismatched} | ${report.counts.unexpected} | ${report.counts.unmatchable} | ${report.counts.artifactDownloadFailures} |`,
    '',
    `Dispatch latency (${report.latencyMs.samples} samples): p50 ${value(report.latencyMs.p50)}, p95 ${value(report.latencyMs.p95)}, max ${value(report.latencyMs.max)}`,
  ];
  for (const [heading, entries] of [
    ['Missing dispatches', report.missing],
    ['Duplicate dispatches', report.duplicates],
    ['Identity mismatches', report.mismatched],
    ['Unexpected observations', report.unexpected],
    ['Unmatchable observations', report.unmatchable],
    ['Artifact download failures', report.artifactDownloadFailures],
  ]) {
    if (entries.length === 0) continue;
    lines.push(
      '',
      `### ${heading}`,
      '',
      '```json',
      JSON.stringify(entries, null, 2),
      '```'
    );
  }
  return `${lines.join('\n')}\n`;
}

async function fetchDeployments({ token, teamId, projectId, from }) {
  const deployments = [];
  let until;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL('https://api.vercel.com/v6/deployments');
    url.searchParams.set('teamId', teamId);
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('limit', '100');
    if (until) url.searchParams.set('until', String(until));
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Vercel deployments API returned ${response.status}`);
    }
    const body = await response.json();
    const pageDeployments = Array.isArray(body.deployments)
      ? body.deployments
      : [];
    deployments.push(...pageDeployments);
    if (pageDeployments.length === 0) break;
    const oldest = Math.min(
      ...pageDeployments.map((deployment) => deployment.createdAt)
    );
    if (oldest < from || !body.pagination?.next) break;
    until = body.pagination.next;
  }
  return deployments;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${flag || '<end>'}`);
    }
    args[flag.slice(2)] = value;
  }
  return args;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const from = Date.parse(requiredString(args.from, '--from'));
  const to = Date.parse(requiredString(args.to, '--to'));
  const deployments = await fetchDeployments({
    token: requiredString(env.VERCEL_TOKEN, 'VERCEL_TOKEN'),
    teamId: requiredString(env.VERCEL_TEAM_ID, 'VERCEL_TEAM_ID'),
    projectId: PROJECT.id,
    from,
  });
  const observations = loadObservations(
    requiredString(args.observations, '--observations')
  );
  const runs = JSON.parse(
    fs.readFileSync(requiredString(args.runs, '--runs'), 'utf8')
  );
  const downloadFailures = fs
    .readFileSync(
      requiredString(args['download-failures'], '--download-failures'),
      'utf8'
    )
    .split('\n')
    .filter(Boolean);
  const report = reconcile({
    deployments,
    observations,
    runs,
    downloadFailures,
    from,
    to,
  });
  fs.writeFileSync(
    requiredString(args.output, '--output'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  fs.writeFileSync(
    requiredString(args.markdown, '--markdown'),
    renderMarkdown(report)
  );
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  PROJECT,
  OBSERVATION_STARTED_AT,
  normalizeDeployment,
  reconcile,
  renderMarkdown,
  fetchDeployments,
  main,
};
