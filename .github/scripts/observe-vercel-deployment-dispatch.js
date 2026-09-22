const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const EVENT_PREFIX = 'vercel.deployment.';
const OBSERVED_PROJECT = {
  id: 'prj_yjkM7UdHliv8bfxZ1sMJQf1pMpdi',
  name: 'example-nextjs-workflow-turbopack',
};
const STATE_DETAILS = {
  success: new Set(['checks_skipped']),
  error: new Set(['deployment_deleted']),
  failed: new Set([
    'checks_failed',
    'aliasing_failed',
    'deployment_failed',
    'deployment_blocked',
    'account_blocked',
    'authorization_required',
    'missing_vercel_access',
    'no_vercel_account',
  ]),
  canceled: new Set(),
  ignored: new Set(),
  skipped: new Set(),
};

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, field);
}

function deploymentUrl(value) {
  const raw = requiredString(value, 'client_payload.url');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('client_payload.url must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('client_payload.url must use HTTPS');
  }
  return parsed.toString();
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function parseEvent(eventType) {
  const type = requiredString(eventType, 'event type');
  if (!type.startsWith(EVENT_PREFIX)) {
    throw new Error(`unsupported event type: ${type}`);
  }
  const state = type.slice(EVENT_PREFIX.length);
  if (!Object.hasOwn(STATE_DETAILS, state)) {
    throw new Error(`unsupported deployment state: ${state}`);
  }
  return { type, state };
}

function parseProject(value) {
  const project = object(value, 'client_payload.project');
  const id = requiredString(project.id, 'client_payload.project.id');
  const name = requiredString(project.name, 'client_payload.project.name');
  if (id !== OBSERVED_PROJECT.id || name !== OBSERVED_PROJECT.name) {
    throw new Error(
      `unexpected project: ${name} (${id}); expected ${OBSERVED_PROJECT.name} (${OBSERVED_PROJECT.id})`
    );
  }
  return { id, name };
}

function parseGit(value) {
  const git = object(value, 'client_payload.git');
  const sha = requiredString(git.sha, 'client_payload.git.sha');
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error('client_payload.git.sha must be a full commit SHA');
  }
  const shortSha = requiredString(git.shortSha, 'client_payload.git.shortSha');
  if (
    !/^[0-9a-f]{7}$/i.test(shortSha) ||
    !sha.toLowerCase().startsWith(shortSha.toLowerCase())
  ) {
    throw new Error(
      'client_payload.git.shortSha must be the first 7 characters of client_payload.git.sha'
    );
  }
  return {
    sha: sha.toLowerCase(),
    ref: requiredString(git.ref, 'client_payload.git.ref'),
    shortSha: shortSha.toLowerCase(),
  };
}

function parseStateDetail(stateType, value) {
  const detail = optionalString(value, 'client_payload.state.detail');
  if (stateType === 'failed' && !detail) {
    throw new Error(
      'client_payload.state.detail is required for failed events'
    );
  }
  if (detail && !STATE_DETAILS[stateType].has(detail)) {
    throw new Error(
      `client_payload.state.detail ${detail} is not valid for ${stateType} events`
    );
  }
  return detail;
}

function parseDeployment(payload, event) {
  const state = object(payload.state, 'client_payload.state');
  const stateType = requiredString(state.type, 'client_payload.state.type');
  if (stateType !== event.state) {
    throw new Error(
      `event type ${event.type} does not match client_payload.state.type ${stateType}`
    );
  }
  const id = optionalString(payload.id, 'client_payload.id');
  const url =
    payload.url === undefined ? undefined : deploymentUrl(payload.url);
  if (event.state === 'success' && (!id || !url)) {
    throw new Error('successful deployment events must include id and url');
  }
  if (id && !id.startsWith('dpl_')) {
    throw new Error('client_payload.id must start with dpl_');
  }
  const detail = parseStateDetail(stateType, state.detail);
  const errorPresent = Boolean(
    optionalString(payload.error, 'client_payload.error')
  );
  return {
    ...(id ? { id } : {}),
    ...(url ? { url } : {}),
    environment: requiredString(
      payload.environment,
      'client_payload.environment'
    ),
    state: { type: stateType, ...(detail ? { detail } : {}) },
    ...(errorPresent ? { errorPresent: true } : {}),
  };
}

function normalizeDeploymentDispatch({ eventType, payload, observedAt, run }) {
  const event = parseEvent(eventType);
  const data = object(payload, 'client_payload');
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'vercel-repository-dispatch',
    observedAt: requiredString(observedAt, 'observedAt'),
    eventType: event.type,
    project: parseProject(data.project),
    deployment: parseDeployment(data, event),
    git: parseGit(data.git),
    github: {
      repository: requiredString(run.repository, 'github.repository'),
      runId: requiredString(run.id, 'github.runId'),
      runAttempt: requiredString(run.attempt, 'github.runAttempt'),
      runUrl: requiredString(run.url, 'github.runUrl'),
    },
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${flag || '<end>'}`);
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const eventPath = requiredString(args['event-path'], '--event-path');
  const output = requiredString(args.output, '--output');
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const isManual = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const eventType = isManual ? event.inputs?.event_type : event.action;
  const payload = isManual
    ? JSON.parse(
        requiredString(event.inputs?.client_payload, 'inputs.client_payload')
      )
    : event.client_payload;

  const record = normalizeDeploymentDispatch({
    eventType,
    payload,
    observedAt: env.OBSERVED_AT || new Date().toISOString(),
    run: {
      repository: env.GITHUB_REPOSITORY,
      id: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    },
  });

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  OBSERVED_PROJECT,
  normalizeDeploymentDispatch,
  main,
};
