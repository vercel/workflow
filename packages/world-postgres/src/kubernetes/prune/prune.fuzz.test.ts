import { describe, expect, it } from 'vitest';
import type { KubeApi } from './kube.js';
import { type BacklogSource, pruneWorkers } from './prune.js';

/**
 * Randomized check of `pruneWorkers` against a modeled cluster and database:
 * releases roll out, runs start and finish, workers are deleted by hand, and
 * every Kubernetes call and backlog read can fail, either before it takes
 * effect or after (the response is lost). After every prune, nothing a
 * version still needs may be gone; after a prune where nothing fails, every
 * version with unfinished runs has workers that can scale, and no drained
 * version has any.
 */

const NS = '/apis/apps/v1/namespaces/default';
const KEDA = '/apis/keda.sh/v1alpha1/namespaces/default/scaledobjects';
const SERVICE = 'svc';
const MIN_AGE_MS = 60_000;

/** Deterministic PRNG (mulberry32), so a failing seed reproduces. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Model {
  now: number;
  /** Worker Deployments and ScaledObjects, by name. */
  deployments: Map<string, Record<string, any>>;
  scaledObjects: Map<string, Record<string, any>>;
  /** The main Deployment's version, and versions whose ReplicaSets still have pods. */
  mainVersion: string;
  liveReplicaSets: Set<string>;
  /** Unfinished runs per version. */
  runs: Map<string, number>;
}

const workerName = (version: string) => `${SERVICE}-wf-${version}`;
const labels = (version: string) => ({
  'workflow.vercel.com/service': SERVICE,
  'workflow.vercel.com/role': 'worker',
  'workflow.vercel.com/version': version,
});

function deploy(model: Model, version: string) {
  const name = workerName(version);
  model.deployments.set(name, {
    metadata: {
      name,
      labels: labels(version),
      creationTimestamp: new Date(model.now).toISOString(),
      uid: `uid-${name}`,
      resourceVersion: '1',
    },
    spec: {
      replicas: 0,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name, ...labels(version) } },
        spec: { containers: [{ image: `registry/svc:${version}` }] },
      },
    },
  });
  model.scaledObjects.set(name, {
    metadata: { name, labels: labels(version), uid: `so-${name}` },
    spec: {
      scaleTargetRef: { name },
      minReplicaCount: 0,
      triggers: [
        {
          type: 'metrics-api',
          metadata: { url: `http://svc/internal/workflow/backlog/${version}` },
        },
      ],
    },
  });
  model.liveReplicaSets.add(model.mainVersion);
  model.mainVersion = version;
}

function versionOf(object: Record<string, any>): string {
  return object.metadata.labels['workflow.vercel.com/version'];
}

/** The modeled API server, failing each call with probability `failRate`. */
function fakeApi(model: Model, random: () => number, failRate: number) {
  const fail = (where: string) => {
    if (random() < failRate) throw new Error(`injected failure: ${where}`);
  };
  // A mutation either fails before it applies, or applies and then reports
  // a failure (the response was lost).
  const mutate = (where: string, apply: () => void) => {
    fail(where);
    apply();
    fail(`${where} (after applying)`);
  };
  const api: KubeApi = {
    async get<T>(path: string): Promise<T> {
      fail(`GET ${path}`);
      const [base] = path.split('?') as [string];
      if (base === `${NS}/deployments`) {
        return { items: [...model.deployments.values()] } as T;
      }
      if (base === KEDA) {
        return { items: [...model.scaledObjects.values()] } as T;
      }
      if (base === `${NS}/deployments/${SERVICE}`) {
        return {
          metadata: { name: SERVICE },
          spec: {
            selector: { matchLabels: { app: SERVICE } },
            template: {
              metadata: {
                labels: { 'app.kubernetes.io/version': model.mainVersion },
              },
            },
          },
        } as T;
      }
      if (base === `${NS}/replicasets`) {
        return {
          items: [...model.liveReplicaSets].map((version) => ({
            metadata: {
              name: `${SERVICE}-${version.slice(0, 8)}`,
              ownerReferences: [{ kind: 'Deployment', name: SERVICE }],
            },
            spec: {
              replicas: 0,
              template: {
                metadata: { labels: { 'app.kubernetes.io/version': version } },
              },
            },
            status: { replicas: 1 },
          })),
        } as T;
      }
      if (base.startsWith(`${KEDA}/`)) {
        const object = model.scaledObjects.get(base.slice(KEDA.length + 1));
        if (!object) throw new Error(`404 ${base}`);
        return structuredClone(object) as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async create(path, body) {
      const object = structuredClone(body) as Record<string, any>;
      const store =
        path === `${NS}/deployments`
          ? model.deployments
          : path === KEDA
            ? model.scaledObjects
            : undefined;
      if (!store) throw new Error(`unexpected POST ${path}`);
      mutate(`POST ${path}`, () => {
        if (store.has(object.metadata.name)) {
          throw Object.assign(new Error(`409 ${object.metadata.name}`), {
            status: 409,
          });
        }
        object.metadata.creationTimestamp = new Date(model.now).toISOString();
        store.set(object.metadata.name, object);
      });
    },
    async delete(path) {
      mutate(`DELETE ${path}`, () => {
        if (path.startsWith(`${KEDA}/`)) {
          model.scaledObjects.delete(path.slice(KEDA.length + 1));
        } else if (path.startsWith(`${NS}/deployments/`)) {
          model.deployments.delete(path.slice(`${NS}/deployments/`.length));
        } else {
          throw new Error(`unexpected DELETE ${path}`);
        }
      });
    },
  };
  return api;
}

function fakeBacklog(
  model: Model,
  random: () => number,
  failRate: number
): BacklogSource {
  return {
    async backlog(version) {
      if (random() < failRate) throw new Error('injected backlog failure');
      const activeRuns = model.runs.get(version) ?? 0;
      return { version, activeRuns, dueDeliveries: 0, wanted: 0 };
    },
    async activeVersions() {
      if (random() < failRate) throw new Error('injected versions failure');
      return new Map([...model.runs].filter(([, n]) => n > 0));
    },
  };
}

function sha(random: () => number): string {
  let out = '';
  for (let i = 0; i < 40; i++) out += Math.floor(random() * 16).toString(16);
  return out;
}

function prune(model: Model, random: () => number, failRate: number) {
  return pruneWorkers({
    api: fakeApi(model, random, failRate),
    namespace: 'default',
    service: SERVICE,
    mainDeployment: SERVICE,
    backlog: fakeBacklog(model, random, failRate),
    minAgeMs: MIN_AGE_MS,
    now: new Date(model.now),
  });
}

const versionsWith = (store: Map<string, Record<string, any>>) =>
  new Set([...store.values()].map(versionOf));

describe('pruneWorkers (randomized)', () => {
  it.each(
    Array.from({ length: 1000 }, (_, seed) => seed)
  )('keeps what versions need and converges, seed %i', async (seed) => {
    const random = prng(seed);
    const first = sha(random);
    const model: Model = {
      now: Date.parse('2026-11-01T00:00:00Z'),
      deployments: new Map(),
      scaledObjects: new Map(),
      mainVersion: first,
      liveReplicaSets: new Set(),
      runs: new Map(),
    };
    deploy(model, first);
    model.liveReplicaSets.clear();

    for (let step = 0; step < 25; step++) {
      const roll = random();
      if (roll < 0.15) {
        deploy(model, sha(random));
      } else if (roll < 0.35) {
        model.runs.set(
          model.mainVersion,
          (model.runs.get(model.mainVersion) ?? 0) + 1
        );
      } else if (roll < 0.55) {
        const busy = [...model.runs].filter(([, n]) => n > 0);
        if (busy.length > 0) {
          const [version, n] = busy[Math.floor(random() * busy.length)]!;
          model.runs.set(version, n - 1);
        }
      } else if (roll < 0.62) {
        // A rollout finishes: old ReplicaSets lose their pods.
        model.liveReplicaSets.clear();
      } else if (roll < 0.68) {
        // Someone deletes a Deployment or a ScaledObject by hand, of any
        // version, the current one included.
        const store = random() < 0.5 ? model.deployments : model.scaledObjects;
        const names = [...store.keys()];
        if (names.length > 0) {
          store.delete(names[Math.floor(random() * names.length)]!);
        }
      }
      model.now += Math.floor(random() * 2 * MIN_AGE_MS);

      // Safety, through failures: a version that is protected or has
      // unfinished runs keeps whatever workers it had.
      const needed = new Set([
        model.mainVersion,
        ...model.liveReplicaSets,
        ...[...model.runs].filter(([, n]) => n > 0).map(([v]) => v),
      ]);
      const before = {
        deployments: versionsWith(model.deployments),
        scaledObjects: versionsWith(model.scaledObjects),
      };
      // Listing workers or the main Deployment failing aborts the prune,
      // which is safe: it changes nothing.
      await prune(model, random, 0.15).catch(() => undefined);
      for (const version of needed) {
        if (before.deployments.has(version)) {
          expect(versionsWith(model.deployments)).toContain(version);
        }
        if (before.scaledObjects.has(version)) {
          expect(versionsWith(model.scaledObjects)).toContain(version);
        }
      }
    }

    // Liveness: one prune with nothing failing repairs everything.
    model.liveReplicaSets.clear();
    model.now += 2 * MIN_AGE_MS;
    const result = await prune(model, random, 0);
    // The only acceptable failure: nothing of any other version is left to
    // copy (every Deployment or every ScaledObject was deleted by hand).
    const uncopyable =
      /no (worker Deployment|ScaledObject) of any version to copy/;
    for (const error of result.errors) expect(error).toMatch(uncopyable);
    const stuck = new Set(
      result.errors.map((e) => e.split(' ')[1]?.replace(/:$/, ''))
    );

    const deployments = versionsWith(model.deployments);
    const scaledObjects = versionsWith(model.scaledObjects);
    const active = [...model.runs].filter(([, n]) => n > 0).map(([v]) => v);
    for (const version of active) {
      if (stuck.has(version)) continue;
      expect(deployments).toContain(version);
      expect(scaledObjects).toContain(version);
    }
    // No Deployment is left without a ScaledObject to scale it.
    for (const version of deployments) {
      if (stuck.has(version)) continue;
      expect(scaledObjects).toContain(version);
    }
    // Drained versions are gone.
    for (const version of [...deployments, ...scaledObjects]) {
      expect(version === model.mainVersion || active.includes(version)).toBe(
        true
      );
    }
  });
});
