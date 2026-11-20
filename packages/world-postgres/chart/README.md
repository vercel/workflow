# `workflow-postgres` Helm chart

Deploys an application that runs Workflow SDK workflows on `@workflow/world-postgres` in Kubernetes. Every run is pinned to the image version that started it, the way Vercel deployments pin runs on the Vercel World: a rollout never continues an in-flight run on new code.

The chart ships in the npm package, so an application that depends on `@workflow/world-postgres` can install it from `node_modules`:

```sh
helm upgrade --install billing node_modules/@workflow/world-postgres/chart \
  --set serviceName=billing \
  --set image.repository=registry.example.com/billing \
  --set image.tag="$(git rev-parse HEAD)" \
  --set env.WORKFLOW_POSTGRES_URL="postgres://…"
```

It needs [KEDA](https://keda.sh) in the cluster.

## What it installs

| Resource | Per | Purpose |
| --- | --- | --- |
| Deployment `<serviceName>` and Service | release | Serves the application, the probes and the backlog endpoints, and runs this release's workflows. |
| Deployment `<serviceName>-wf-<tag>` | version | Runs only the workflows that version started. No Service traffic. |
| ScaledObject `<serviceName>-wf-<tag>` | version | KEDA scales that version's workers between 0 and `versionPinning.workers.maxReplicas` on its due deliveries (`<backlogPath>/backlog/<tag>`, field `wanted`). |
| CronJob `<serviceName>-workflow-prune`, with its ServiceAccount, Role and RoleBinding | release | Deletes the workers of versions whose runs have all finished, and recreates those of versions that have unfinished runs but no workers. |

The worker Deployment and ScaledObject carry `helm.sh/resource-policy: keep`. Without it, `helm upgrade` to a new tag would delete the previous version's workers while its runs still need them. With it, Helm stops tracking them on upgrade, and only the prune job deletes them.

Every container gets the configuration `createWorld()` reads:
- `WORKFLOW_POSTGRES_JOB_PREFIX`: `jobPrefix`, by default derived from `serviceName`;
- `WORKFLOW_POSTGRES_DEPLOYMENT_ID`: the image tag, which pins runs;
- `WORKFLOW_ROLE`: `service`, `worker` or `prune`;
- `PORT`, and everything in `env` and `envFrom`.

## The application image

One image serves all three roles. Its entrypoint reads `WORKFLOW_ROLE`:

```ts
import { createServer } from 'node:http';
import { createWorld } from '@workflow/world-postgres';
import {
  createBacklogEndpoints,
  createLifecycle,
  pruneWorkersInCluster,
  resolveWorkflowRole,
} from '@workflow/world-postgres/kubernetes';
import pg from 'pg';
import { setWorld } from 'workflow/runtime';

const role = resolveWorkflowRole();
if (role === 'prune') {
  const result = await pruneWorkersInCluster();
  process.exit(result.errors.length > 0 ? 1 : 0);
}

const pool = new pg.Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
const config = {
  pool,
  jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
  // Pins every run this process starts to its image tag.
  deploymentId: process.env.WORKFLOW_POSTGRES_DEPLOYMENT_ID || undefined,
  // `createLifecycle` below drains on SIGTERM.
  applicationManagedShutdown: true,
};
const world = createWorld(config);
setWorld(world);
await world.start();

const backlog = createBacklogEndpoints({ pool, config });
const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const reply =
    lifecycle.probe(pathname) ??
    (role === 'service' ? await backlog.respond(req.method ?? 'GET', pathname) : undefined);
  if (reply) {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(reply.body));
  }
  // A worker serves only the Workflow SDK's routes: the queue delivers each
  // job to this pod's own flow route.
  if (role === 'worker' && !pathname.startsWith('/.well-known/workflow/')) {
    return res.writeHead(404).end();
  }
  // …the application's own routes, including the Workflow SDK's.
});
server.listen(Number(process.env.PORT));

const lifecycle = createLifecycle({
  close: async () => {
    // The World first: it stops claiming jobs and waits for running
    // deliveries, which reach this server's flow route.
    await world.close?.();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  },
});
```

The backlog endpoints disclose run counts: serve them only inside the cluster, or behind your own authentication.

A Dockerfile needs nothing specific to this chart, beyond an immutable tag per build:

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY . .
RUN pnpm build
CMD ["node", "dist/server.js"]
```

To run the prune job without your entrypoint, set `versionPinning.prune.command` to the bundled CLI:

```yaml
versionPinning:
  prune:
    command: [node, node_modules/@workflow/world-postgres/bin/prune.js, --in-cluster]
```

## Migrations

Run `bootstrap` before a new version's pods start, or let the chart do it in an init container of every pod:

```yaml
migrations:
  enabled: true
  command: [node, node_modules/@workflow/world-postgres/bin/setup.js]
```

`bootstrap` is idempotent and safe to run from several pods at once. Old versions keep using the database until their last run finishes, so every migration must stay compatible with the oldest version that still has workers.

## Use one immutable tag per build

The commit SHA is the right choice:
- the tag is the deployment ID runs are pinned to;
- it names that version's workers;
- restoring a version's lost workers swaps it into a copy of another version's manifests, which is why restoring needs a SHA.

The chart refuses tags it can't use: longer than 40 characters, with characters a deployment ID can't hold, `postgres` (reserved for unpinned runs), or too long together with `jobPrefix` for Graphile Worker's 128 character names.

## How long old versions run

An old version keeps its workers until its last run finishes, with no time limit. A run started with `experimental_retention: 0` counts as unfinished until the check that its data was deleted has run, about a minute after it ends. Its pods scale to zero while nothing is due, including while its runs sleep or wait on a hook, and back up when a timer fires or a hook is resumed, even from a newer version.

The prune job never deletes a version's workers unless all of these hold:
- the version isn't the release's current version, and isn't the version of any of the main Deployment's ReplicaSets that still has pods (a rollout in progress, or a rollback);
- the workers are older than `versionPinning.prune.minAgeMinutes`;
- its backlog was read, and it reports no unfinished runs;
- the list of versions with unfinished runs was read, and the version isn't in it.

If any of these can't be checked, the workers are kept.

Things to plan for:
- **Runs that never finish** keep their version forever. Give hooks a timeout.
- **Child runs** inherit their parent's version.
- **Runs started without a deployment ID** are unpinned, and every pod this chart renders is pinned, so nothing claims them by default. See [Unpinned runs](#unpinned-runs).
- **A delivery still running when its pod stops** is redelivered from the start once its job lock goes stale. Keep `terminationGracePeriodSeconds` above your longest delivery.

## Unpinned runs

A run started without a deployment ID waits for a process without one. Two kinds exist:
- the in-flight runs of an application that adopts this chart, started before its runs were pinned;
- runs created by a tool that doesn't set `WORKFLOW_POSTGRES_DEPLOYMENT_ID`, such as a re-run from a CLI or dashboard.

Enable `unpinnedWorker` to run them on the current release's image, with a fixed number of pods:

```yaml
unpinnedWorker:
  enabled: true
  replicas: 1
```

The backlog endpoints report how many there are (`unpinnedRuns` in `<backlogPath>/versions`), and the prune job logs a warning while there are any and no unpinned worker is deployed.

When adopting the chart, either let the previous deployment finish its in-flight runs before you switch, or enable `unpinnedWorker` until `unpinnedRuns` reaches zero. Leave it on if tools outside the release start runs. Give those tools `WORKFLOW_POSTGRES_DEPLOYMENT_ID` instead to pin their runs to a version.

## Uninstalling

The per-version worker Deployments and ScaledObjects carry `helm.sh/resource-policy: keep`, so `helm uninstall` leaves them behind. It still deletes:
- the ServiceAccount they run as;
- the Service KEDA reads their backlog from;
- the prune job, which would otherwise delete them.

Their pods can't start again, and a reinstall under another release name conflicts with them. Once their runs have finished, delete them:

```sh
kubectl delete deployment,scaledobject \
  -l workflow.vercel.com/service=<serviceName>,workflow.vercel.com/role=worker
```

To keep their runs going instead, uninstall only after every version but the current one has been pruned.

## Images

The image of every version with workers must stay pullable until those workers are deleted. A KEDA scale-up from zero, or a restore, pulls it again. If your registry expires images, exclude tags that still have a `<serviceName>-wf-<tag>` Deployment, or keep images for longer than your longest-running workflow.

## Permissions

- The prune job runs as its own ServiceAccount, with no database access: it reads backlogs from the service over HTTP.
- Its Role allows reading the main Deployment and listing its ReplicaSets, plus listing, creating and deleting Deployments and ScaledObjects. Kubernetes RBAC can't scope that by label, so install the chart in a namespace of its own.
- The application and its workers run as `serviceAccount`.

## Deploying workers another way

To render a version's workers with your own tooling instead, keep the labels pruning lists them by (`WORKER_LABELS`) and run `workflow-postgres-prune` after each deploy, with your deploy pipeline's `kubectl` credentials:

```sh
npx workflow-postgres-prune --context prod --namespace billing --service billing --version "$TAG"
```

## Test

`tests/kwok-e2e.sh` runs against any API server with RBAC and the KEDA CRDs, such as [kwok](https://kwok.sigs.k8s.io) started with `--secure-port --kube-authorization`. It:
- installs the chart, then upgrades it to a new tag;
- runs pruning as the chart's prune ServiceAccount, so the API server enforces its RBAC;
- reads backlogs from `createBacklogEndpoints` against a real Postgres;
- checks that a version is kept while it has an unfinished run, deleted once it finishes, and restored when it has runs but no workers.
