import { describe, expect, it } from 'vitest';
import type { KubeApi } from './kube.js';
import { type BacklogSource, pruneWorkers } from './prune.js';

const NS = '/apis/apps/v1/namespaces/default';
const KEDA = '/apis/keda.sh/v1alpha1/namespaces/default/scaledobjects';
const OLD = 'a'.repeat(40);
const LIVE = 'b'.repeat(40);
const CURRENT = 'c'.repeat(40);
const created = '2026-11-01T00:00:00Z';

const worker = (version: string) => ({
  metadata: {
    name: `svc-wf-${version}`,
    creationTimestamp: created,
    uid: 'u',
    resourceVersion: '1',
    labels: { 'workflow.vercel.com/version': version },
  },
  spec: {
    selector: { matchLabels: { app: `svc-wf-${version}` } },
    template: { spec: { containers: [{ image: `gcr.io/x/svc:${version}` }] } },
  },
  status: { replicas: 0 },
});

function fakeApi(objects: Record<string, unknown>) {
  const calls: string[] = [];
  const api: KubeApi = {
    get: async <T>(path: string) => {
      calls.push(`GET ${path}`);
      const key = path.split('?')[0] as string;
      if (!(key in objects)) throw new Error(`404 ${key}`);
      return objects[key] as T;
    },
    create: async (path, body) => {
      calls.push(
        `POST ${path} ${(body as { metadata: { name: string } }).metadata.name}`
      );
    },
    delete: async (path) => {
      calls.push(`DELETE ${path}`);
    },
  };
  return { api, calls };
}

const cluster = (workers: unknown[]): Record<string, unknown> => ({
  [`${NS}/deployments`]: { items: workers },
  [`${NS}/deployments/svc`]: {
    metadata: { name: 'svc' },
    spec: {
      selector: { matchLabels: { app: 'svc' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/version': CURRENT } },
      },
    },
  },
  [`${NS}/replicasets`]: {
    items: [
      {
        metadata: {
          name: 'svc-1',
          ownerReferences: [{ kind: 'Deployment', name: 'svc' }],
        },
        spec: {
          replicas: 0,
          template: {
            metadata: { labels: { 'app.kubernetes.io/version': LIVE } },
          },
        },
        status: { replicas: 2 },
      },
    ],
  },
  [`${KEDA}/svc-wf-${CURRENT}`]: {
    metadata: { name: `svc-wf-${CURRENT}` },
    spec: {},
  },
});

const drained: BacklogSource = {
  backlog: async (version) => ({
    version,
    activeRuns: 0,
    dueDeliveries: 0,
    wanted: 0,
  }),
  activeVersions: async () => new Map(),
};

const options = {
  namespace: 'default',
  service: 'svc',
  mainDeployment: 'svc',
  minAgeMs: 0,
};

describe('pruneWorkers', () => {
  it('deletes a drained version, ScaledObject first, and protects live ReplicaSet versions', async () => {
    const { api, calls } = fakeApi(
      cluster([worker(OLD), worker(LIVE), worker(CURRENT)])
    );
    const result = await pruneWorkers({ ...options, api, backlog: drained });

    expect(result.deleted).toEqual([OLD]);
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([
      `DELETE ${KEDA}/svc-wf-${OLD}`,
      `DELETE ${NS}/deployments/svc-wf-${OLD}`,
    ]);
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        kind: 'keep',
        reason: 'protected',
        worker: expect.objectContaining({ version: LIVE }),
      })
    );
  });

  it('restores a version with unfinished runs from the newest workers, on its own image', async () => {
    const { api, calls } = fakeApi(cluster([worker(CURRENT)]));
    const result = await pruneWorkers({
      ...options,
      api,
      backlog: { ...drained, activeVersions: async () => new Map([[OLD, 2]]) },
      imageExists: async (image) => image === `gcr.io/x/svc:${OLD}`,
    });

    expect(result.restored).toEqual([OLD]);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([
      `POST ${NS}/deployments svc-wf-${OLD}`,
      `POST ${KEDA} svc-wf-${OLD}`,
    ]);
  });

  it('does not restore onto an image that is gone', async () => {
    const { api, calls } = fakeApi(cluster([worker(CURRENT)]));
    const result = await pruneWorkers({
      ...options,
      api,
      backlog: { ...drained, activeVersions: async () => new Map([[OLD, 2]]) },
      imageExists: async () => false,
    });

    expect(result.restored).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining('is gone')]);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('reads backlogs through the service proxy under the endpoints base path', async () => {
    const { api, calls } = fakeApi({
      ...cluster([worker(OLD)]),
      '/api/v1/namespaces/default/services/svc:http/proxy/wf/backlog/x': {
        version: 'x',
        activeRuns: 1,
        dueDeliveries: 0,
        wanted: 0,
      },
    });
    const { serviceProxyBacklogSource } = await import('./prune.js');
    const source = serviceProxyBacklogSource(api, 'default', 'svc', {
      basePath: '/wf',
    });
    await expect(source.backlog('x')).resolves.toMatchObject({ activeRuns: 1 });
    expect(calls).toContain(
      'GET /api/v1/namespaces/default/services/svc:http/proxy/wf/backlog/x'
    );
  });

  it('prunes nothing when the main Deployment cannot be read', async () => {
    const objects = cluster([worker(OLD)]);
    delete objects[`${NS}/deployments/svc`];
    const { api, calls } = fakeApi(objects);

    await expect(
      pruneWorkers({ ...options, api, backlog: drained })
    ).rejects.toThrow('404');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });
});
