const fs = require('node:fs');

const PROJECT = {
  id: 'prj_yjkM7UdHliv8bfxZ1sMJQf1pMpdi',
  name: 'example-nextjs-workflow-turbopack',
};

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function expectedEnvironment(deployment) {
  return deployment.target === 'production' ? 'production' : 'preview';
}

function normalizedUrl(value, field) {
  const raw = requiredString(value, field);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${field} must use HTTPS`);
  }
  return url.toString();
}

function verify({ payload, deployment }) {
  const payloadId = requiredString(payload.id, 'client_payload.id');
  const deploymentId = requiredString(
    deployment.id || deployment.uid,
    'deployment.id'
  );
  const expected = {
    id: payloadId,
    projectId: requiredString(payload.project?.id, 'client_payload.project.id'),
    projectName: requiredString(
      payload.project?.name,
      'client_payload.project.name'
    ),
    sha: requiredString(
      payload.git?.sha,
      'client_payload.git.sha'
    ).toLowerCase(),
    ref: requiredString(payload.git?.ref, 'client_payload.git.ref'),
    environment: requiredString(
      payload.environment,
      'client_payload.environment'
    ),
    url: normalizedUrl(payload.url, 'client_payload.url'),
    state: requiredString(payload.state?.type, 'client_payload.state.type'),
  };
  const actual = {
    id: deploymentId,
    projectId: deployment.projectId,
    projectName: deployment.name,
    sha: deployment.meta?.githubCommitSha?.toLowerCase(),
    ref: deployment.meta?.githubCommitRef,
    environment: expectedEnvironment(deployment),
    url: normalizedUrl(`https://${deployment.url}`, 'deployment.url'),
    state: deployment.readyState === 'READY' ? 'success' : undefined,
  };
  if (!/^[0-9a-f]{40}$/.test(expected.sha)) {
    throw new Error('client_payload.git.sha must be a full commit SHA');
  }
  const differences = Object.keys(expected)
    .filter((field) => expected[field] !== actual[field])
    .map((field) => ({
      field,
      expected: expected[field],
      actual: actual[field],
    }));
  if (
    expected.projectId !== PROJECT.id ||
    expected.projectName !== PROJECT.name
  ) {
    differences.push({
      field: 'configuredProject',
      expected: PROJECT,
      actual: {
        id: expected.projectId,
        name: expected.projectName,
      },
    });
  }
  if (deployment.source !== 'git') {
    differences.push({
      field: 'deployment.source',
      expected: 'git',
      actual: deployment.source,
    });
  }
  if (deployment.meta?.githubCommitOrg !== 'vercel') {
    differences.push({
      field: 'deployment.meta.githubCommitOrg',
      expected: 'vercel',
      actual: deployment.meta?.githubCommitOrg,
    });
  }
  if (deployment.meta?.githubCommitRepo !== 'workflow') {
    differences.push({
      field: 'deployment.meta.githubCommitRepo',
      expected: 'workflow',
      actual: deployment.meta?.githubCommitRepo,
    });
  }
  if (differences.length > 0) {
    throw new Error(
      `repository dispatch does not match the Vercel deployment: ${JSON.stringify(differences)}`
    );
  }
  return {
    deploymentId,
    deploymentUrl: actual.url,
    inspectorUrl: deployment.inspectorUrl,
    environment: actual.environment,
    sha: actual.sha,
    ref: actual.ref,
    projectId: actual.projectId,
    projectName: actual.projectName,
  };
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
  const event = JSON.parse(
    fs.readFileSync(requiredString(args['event-path'], '--event-path'), 'utf8')
  );
  const payload = event.client_payload;
  const deploymentId = requiredString(payload?.id, 'client_payload.id');
  const teamId = requiredString(env.VERCEL_TEAM_ID, 'VERCEL_TEAM_ID');
  const response = await fetch(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}?teamId=${encodeURIComponent(teamId)}`,
    {
      headers: {
        authorization: `Bearer ${requiredString(env.VERCEL_TOKEN, 'VERCEL_TOKEN')}`,
      },
    }
  );
  if (!response.ok) {
    throw new Error(`Vercel deployment lookup returned ${response.status}`);
  }
  const result = verify({ payload, deployment: await response.json() });
  const output = requiredString(args.output, '--output');
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { PROJECT, verify, main };
