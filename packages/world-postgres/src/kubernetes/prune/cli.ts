import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseArgs, promisify } from 'node:util';
import { formatPruneResult, pruneWorkersInCluster } from './in-cluster.js';
import { kubectlApi } from './kube.js';
import {
  httpBacklogSource,
  type PruneResult,
  pruneWorkers,
  serviceProxyBacklogSource,
} from './prune.js';

const USAGE = `Usage: workflow-postgres-prune [options]

Deletes the worker Deployments of versions whose runs have all finished, and
recreates those of versions with unfinished runs but no workers.

  --in-cluster              Run as the pod's service account, configured by
                            WORKFLOW_PRUNE_* variables (the Helm chart's CronJob)
  --service <name>          The workflow.vercel.com/service label value
  --context <name>          kubectl context (default: current)
  --namespace <name>        Namespace (default: default)
  --main-deployment <name>  The main Deployment (default: --service)
  --version <version>       The version being deployed now: never pruned
  --backlog-url <url>       Read backlogs from this base URL instead of the API
                            server's service proxy (default path /internal/workflow)
  --backlog-path <path>     The backlog endpoints' path on the service
                            (default /internal/workflow)
  --min-age-minutes <n>     Keep workers younger than this (default 60)
  --skip-image-check        Restore without checking the image with
                            \`docker manifest inspect\`
  --dry-run                 Decide, but change nothing
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'in-cluster': { type: 'boolean', default: false },
      service: { type: 'string' },
      context: { type: 'string' },
      namespace: { type: 'string', default: 'default' },
      'main-deployment': { type: 'string' },
      version: { type: 'string' },
      'backlog-url': { type: 'string' },
      'backlog-path': { type: 'string', default: '/internal/workflow' },
      'min-age-minutes': { type: 'string', default: '60' },
      'skip-image-check': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  let result: PruneResult;
  let target: string;
  if (values['in-cluster']) {
    result = await pruneWorkersInCluster();
    target = process.env.WORKFLOW_PRUNE_SERVICE ?? '';
  } else {
    if (!values.service) {
      console.error(`--service is required\n\n${USAGE}`);
      return 2;
    }
    const namespace = values.namespace ?? 'default';
    const api = kubectlApi({ context: values.context });
    const backlogUrl = values['backlog-url']?.replace(/\/+$/, '');
    result = await pruneWorkers({
      api,
      namespace,
      service: values.service,
      mainDeployment: values['main-deployment'] ?? values.service,
      deployingVersion: values.version,
      backlog: backlogUrl
        ? httpBacklogSource(async (path) => {
            const res = await fetch(`${backlogUrl}${path}`);
            if (!res.ok)
              throw new Error(`GET ${backlogUrl}${path}: ${res.status}`);
            return res.json();
          })
        : serviceProxyBacklogSource(api, namespace, values.service, {
            basePath: values['backlog-path'],
          }),
      minAgeMs: Number(values['min-age-minutes']) * 60_000,
      dryRun: values['dry-run'],
      imageExists: values['skip-image-check'] ? undefined : imageExists,
    });
    target = `${values.service} in ${values.context ?? 'the current context'}`;
  }

  const summary = [
    `workflow workers of ${target}${values['dry-run'] || process.env.WORKFLOW_PRUNE_DRY_RUN === '1' ? ' (dry run)' : ''}:`,
    ...formatPruneResult(result),
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n\`\`\`\n${summary}\n\`\`\`\n`
    );
  }
  return result.errors.length > 0 ? 1 : 0;
}

/** Whether the registry still has the image, with the local `docker` login. */
async function imageExists(image: string): Promise<boolean> {
  try {
    await promisify(execFile)('docker', ['manifest', 'inspect', image]);
    return true;
  } catch {
    return false;
  }
}
