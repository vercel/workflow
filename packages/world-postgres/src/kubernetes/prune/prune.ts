import type { VersionBacklog } from '../backlog-handler.js';
import type { KubeApi } from './kube.js';
import { APP_VERSION_LABEL, WORKER_LABELS, WORKER_ROLE } from './labels.js';
import { type PruneAction, planPrune, type WorkerDeployment } from './plan.js';

/** Where a version's backlog is read from. */
export interface BacklogSource {
  backlog(version: string): Promise<VersionBacklog>;
  activeVersions(): Promise<Map<string, number>>;
}

/**
 * Reads the backlog endpoints (`createBacklogEndpoints`) through `get`,
 * which may be a plain fetch or the Kubernetes API server's service proxy.
 * `get` receives paths below the endpoints' base path, such as
 * `/backlog/<version>`.
 */
export function httpBacklogSource(
  get: (path: string) => Promise<unknown>
): BacklogSource {
  return {
    backlog: async (version) =>
      (await get(`/backlog/${encodeURIComponent(version)}`)) as VersionBacklog,
    activeVersions: async () => {
      const { versions } = (await get('/versions')) as {
        versions: Record<string, number>;
      };
      return new Map(Object.entries(versions));
    },
  };
}

/** `httpBacklogSource` over the API server's proxy to the service's `http` port. */
export function serviceProxyBacklogSource(
  api: KubeApi,
  namespace: string,
  service: string,
  { port = 'http', basePath = '/internal/workflow' } = {}
): BacklogSource {
  return httpBacklogSource((path) =>
    api.get(
      `/api/v1/namespaces/${namespace}/services/${service}:${port}/proxy${basePath}${path}`
    )
  );
}

export interface PruneOptions {
  readonly api: KubeApi;
  readonly namespace: string;
  /** The `workflow.vercel.com/service` label value. */
  readonly service: string;
  /** The service's main (HTTP) Deployment, whose live versions stay protected. */
  readonly mainDeployment: string;
  /** The version being deployed right now, when called from a deploy. */
  readonly deployingVersion?: string;
  readonly backlog: BacklogSource;
  readonly minAgeMs: number;
  readonly dryRun?: boolean;
  readonly now?: Date;
  /**
   * Whether a version's image can still be pulled, checked before restoring
   * its workers. Omitted: assumed present.
   */
  readonly imageExists?: (image: string) => Promise<boolean>;
}

export interface PruneResult {
  readonly actions: readonly PruneAction[];
  readonly deleted: readonly string[];
  readonly restored: readonly string[];
  readonly errors: readonly string[];
}

interface Meta {
  name: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: { kind: string; name: string }[];
  [key: string]: unknown;
}
interface Deployment {
  metadata: Meta;
  spec: {
    replicas?: number;
    selector: { matchLabels?: Record<string, string> };
    template: {
      metadata?: { labels?: Record<string, string> };
      spec?: { containers?: { image?: string }[] };
    };
  };
  status?: unknown;
}
interface ReplicaSet {
  metadata: Meta;
  spec: {
    replicas?: number;
    template?: { metadata?: { labels?: Record<string, string> } };
  };
  status?: { replicas?: number };
}
interface List<T> {
  items: T[];
}

/**
 * Deletes the worker Deployments (and ScaledObjects) of versions that have
 * drained, and recreates those of versions that still have unfinished runs
 * but no workers. See {@link planPrune} for when each happens.
 */
export async function pruneWorkers(
  options: PruneOptions
): Promise<PruneResult> {
  const { api, namespace, service } = options;
  const apps = `/apis/apps/v1/namespaces/${namespace}`;
  const keda = `/apis/keda.sh/v1alpha1/namespaces/${namespace}/scaledobjects`;
  const selector = encodeURIComponent(
    `${WORKER_LABELS.service}=${service},${WORKER_LABELS.role}=${WORKER_ROLE}`
  );

  const listed = await api.get<List<Deployment>>(
    `${apps}/deployments?labelSelector=${selector}`
  );
  const workers: WorkerDeployment[] = [];
  const byVersion = new Map<string, Deployment>();
  for (const item of listed.items) {
    const version = item.metadata.labels?.[WORKER_LABELS.version];
    if (!version) continue;
    byVersion.set(version, item);
    workers.push({
      name: item.metadata.name,
      version,
      createdAt: new Date(item.metadata.creationTimestamp ?? 0),
    });
  }

  // Without the main Deployment there is no way to tell which versions can
  // still start runs, so nothing is pruned: this throws.
  const protectedVersions = await liveVersions(
    api,
    apps,
    options.mainDeployment
  );
  if (options.deployingVersion) protectedVersions.add(options.deployingVersion);

  const backlogs = new Map<string, VersionBacklog | Error>();
  await Promise.all(
    workers.map(async ({ version }) => {
      backlogs.set(
        version,
        await options.backlog.backlog(version).catch(toError)
      );
    })
  );
  const activeVersions = await options.backlog.activeVersions().catch(toError);

  const actions = planPrune({
    now: options.now ?? new Date(),
    workers,
    protectedVersions,
    backlogs,
    activeVersions,
    minAgeMs: options.minAgeMs,
  });

  const deleted: string[] = [];
  const restored: string[] = [];
  const errors: string[] = [];
  if (options.dryRun) return { actions, deleted, restored, errors };

  for (const action of actions) {
    try {
      if (action.kind === 'delete') {
        // The ScaledObject first, so KEDA does not scale up what is being deleted.
        await api.delete(`${keda}/${action.worker.name}`);
        await api.delete(`${apps}/deployments/${action.worker.name}`);
        deleted.push(action.worker.version);
      } else if (action.kind === 'restore') {
        await restore(action.version);
        restored.push(action.version);
      }
    } catch (error) {
      const version =
        action.kind === 'restore' ? action.version : action.worker.version;
      errors.push(`${action.kind} ${version}: ${toError(error).message}`);
    }
  }
  return { actions, deleted, restored, errors };

  /**
   * Repair path: clones the workers of a version that has them (the newest),
   * swapping in the missing version wherever the template's version appears
   * (names, labels, image tag, VERSION env, the ScaledObject's backlog URL).
   */
  async function restore(version: string) {
    const template = newest(workers.filter((w) => w.version !== version));
    if (!template) {
      throw new Error('no worker Deployment of any version to copy');
    }
    // The version is swapped as a string, so it must not occur by accident
    // (as `v1` does in `apps/v1`): restore only commit-SHA-like versions.
    if (
      !/^[0-9a-f]{7,64}$/.test(version) ||
      !/^[0-9a-f]{7,64}$/.test(template.version)
    ) {
      throw new Error(
        `cannot restore non-SHA version ${version} from ${template.version}`
      );
    }
    const swap = <T>(object: T): T =>
      JSON.parse(
        JSON.stringify(object).replaceAll(template.version, version)
      ) as T;

    const deployment = swap(
      toManifest(byVersion.get(template.version) as Deployment)
    );
    const image = deployment.spec.template.spec?.containers?.[0]?.image;
    if (image && options.imageExists && !(await options.imageExists(image))) {
      throw new Error(
        `image ${image} is gone; its runs cannot be resumed without it`
      );
    }
    const scaledObject = await api.get<{ metadata: Meta }>(
      `${keda}/${template.name}`
    );
    await api.create(`${apps}/deployments`, deployment);
    await api.create(keda, swap(toManifest(scaledObject)));
  }
}

async function liveVersions(
  api: KubeApi,
  apps: string,
  name: string
): Promise<Set<string>> {
  const main = await api.get<Deployment>(`${apps}/deployments/${name}`);
  const versions = new Set<string>();
  const specVersion = main.spec.template.metadata?.labels?.[APP_VERSION_LABEL];
  if (specVersion) versions.add(specVersion);

  const matchLabels = main.spec.selector.matchLabels ?? {};
  const selector = encodeURIComponent(
    Object.entries(matchLabels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
  );
  const sets = await api.get<List<ReplicaSet>>(
    `${apps}/replicasets?labelSelector=${selector}`
  );
  for (const rs of sets.items) {
    const owned = rs.metadata.ownerReferences?.some(
      (ref) => ref.kind === 'Deployment' && ref.name === name
    );
    const pods = Math.max(rs.spec.replicas ?? 0, rs.status?.replicas ?? 0);
    const version = rs.spec.template?.metadata?.labels?.[APP_VERSION_LABEL];
    if (owned && pods > 0 && version) versions.add(version);
  }
  return versions;
}

function newest(workers: WorkerDeployment[]): WorkerDeployment | undefined {
  return [...workers].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )[0];
}

/** A live object as a manifest to create again: no server-set fields, no status. */
function toManifest<T extends { metadata: Meta; status?: unknown }>(
  object: T
): T {
  const {
    uid: _uid,
    resourceVersion: _rv,
    creationTimestamp: _ct,
    generation: _gen,
    managedFields: _mf,
    ownerReferences: _or,
    ...metadata
  } = object.metadata;
  const annotations = { ...metadata.annotations };
  delete annotations['deployment.kubernetes.io/revision'];
  delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
  const { status: _status, ...rest } = object;
  return { ...rest, metadata: { ...metadata, annotations } } as T;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
