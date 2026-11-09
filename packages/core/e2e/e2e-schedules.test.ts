import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, test } from 'vitest';
import { getHookByToken, getRun, getWorld } from '../src/runtime';
import { decodeScheduleTopicSuffix } from '../src/schedule-topic';
import { fetchManifest, isJsApp, isLocalDeployment, setupWorld } from './utils';

/**
 * Static schedules declared with `experimental_schedule`.
 *
 * The workbench's `e2eScheduledWorkflow` (workbench/example/workflows/
 * 104_scheduled.ts) sets `experimental_schedule` and has no entry in any
 * vercel.json. This suite checks, against the deployed app, that:
 *
 *   1. the build turned the declaration into a static schedule of the
 *      deployment, targeting the workflow's schedule topic; and
 *   2. running the schedule starts the workflow, with the occurrence as its
 *      `ScheduledRun`, keyed by the occurrence so it starts one run.
 *
 * Vercel Schedules only delivers on Vercel, so local lanes skip it. The
 * schedule is yearly; the test runs it with the Schedules API's `invoke`.
 *
 * Needs WORKFLOW_VERCEL_AUTH_TOKEN, WORKFLOW_VERCEL_TEAM,
 * WORKFLOW_VERCEL_PROJECT and VERCEL_DEPLOYMENT_ID, which every
 * e2e-vercel-* lane sets.
 */

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

const SCHEDULE_NAME = 'workflow-e2e-scheduled';
const SCHEDULES_API = 'https://vercel-schedules.com';
const RUN_TIMEOUT_MS = 120_000;

const token = process.env.WORKFLOW_VERCEL_AUTH_TOKEN;
const teamId = process.env.WORKFLOW_VERCEL_TEAM;
const projectId = process.env.WORKFLOW_VERCEL_PROJECT;
const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;

/**
 * Next.js apps reach Vercel through the platform's Next.js builder, which
 * returns the schedules the Workflow SDK writes next to the flow route once
 * it supports them (vercel/vercel, `@vercel/next`). Until a release with it is
 * what deploys the workbench, those lanes opt in with
 * WORKFLOW_E2E_NEXT_SCHEDULES=1. Every other framework writes Build Output
 * `config.json#schedules` itself.
 */
const nextWithoutBuilderSupport =
  process.env.APP_NAME?.startsWith('nextjs') &&
  process.env.WORKFLOW_E2E_NEXT_SCHEDULES !== '1';

const runs =
  !isLocalDeployment() &&
  isJsApp() &&
  !nextWithoutBuilderSupport &&
  token &&
  teamId &&
  projectId &&
  deploymentId;

/**
 * The Schedules API queries that may select this deployment's environment,
 * most specific first: none for production, the custom environment, the Git
 * branch of a Preview, or the user (with and without the branch) of a CLI
 * deployment. See "Choose an environment" in the Schedules HTTP API
 * reference. A CLI deployment from a detached checkout reports `HEAD` as its
 * branch, and its schedules live under the user alone.
 */
async function scheduleScopes(): Promise<Record<string, string>[]> {
  const res = await fetch(
    `https://api.vercel.com/v13/deployments/${deploymentId}?teamId=${teamId}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(
      `Looking up deployment ${deploymentId} failed: ${res.status} ${await res.text()}`
    );
  }
  const deployment = (await res.json()) as {
    target?: string | null;
    source?: string;
    customEnvironment?: { slug?: string };
    meta?: {
      githubCommitRef?: string;
      gitlabCommitRef?: string;
      bitbucketCommitRef?: string;
    };
    creator?: { uid?: string };
  };
  if (deployment.target === 'production') return [{}];
  if (deployment.customEnvironment?.slug) {
    return [{ env: deployment.customEnvironment.slug }];
  }
  const branch =
    deployment.meta?.githubCommitRef ??
    deployment.meta?.gitlabCommitRef ??
    deployment.meta?.bitbucketCommitRef;
  if (deployment.source === 'git' && branch) return [{ branch }];
  const user = deployment.creator?.uid;
  if (!user) {
    throw new Error(
      `Deployment ${deploymentId} has no creator to scope its schedules to`
    );
  }
  return branch && branch !== 'HEAD'
    ? [{ user, branch }, { user }]
    : [{ user }];
}

let scope: Record<string, string> = {};

async function schedulesApi<T>(
  path: string,
  init?: RequestInit
): Promise<T | undefined> {
  const query = new URLSearchParams({
    teamId: String(teamId),
    projectId: String(projectId),
    ...scope,
  });
  const res = await fetch(`${SCHEDULES_API}${path}?${query}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init?.headers },
  });
  if (!res.ok) {
    throw new Error(
      `${init?.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`
    );
  }
  return res.status === 204 ? undefined : ((await res.json()) as T);
}

describe.skipIf(!runs)('static schedules from experimental_schedule', () => {
  /** The workflow the schedule's topic names; the flow route starts this one. */
  let workflowId: string;

  beforeAll(async () => {
    setupWorld(deploymentUrl);
    // The first scope whose environment exists for the project.
    const candidates = await scheduleScopes();
    for (const candidate of candidates) {
      scope = candidate;
      try {
        await schedulesApi('/v1/schedules', {});
        break;
      } catch (err) {
        if (candidate === candidates.at(-1)) throw err;
      }
    }
  });

  test('the build emits the declaration as a static schedule on the workflow topic', async () => {
    const schedule = await schedulesApi<{
      name: string;
      source: string;
      expression: { type: string; cron?: string };
      target: { type: string; topic?: string };
    }>(`/v1/schedules/${SCHEDULE_NAME}`);

    expect(schedule).toMatchObject({
      name: SCHEDULE_NAME,
      source: 'static',
      expression: { type: 'cron', cron: '0 0 1 1 *' },
      target: { type: 'queue' },
    });

    // The topic names e2eScheduledWorkflow as the deployment compiled it. A
    // symlinked workflow file can be in the manifest under more than one path;
    // the topic must name one of them.
    const topic = schedule?.target.topic ?? '';
    const marker = 'wkf_workflow_schedule_';
    const decoded = decodeScheduleTopicSuffix(
      topic.slice(topic.indexOf(marker) + marker.length)
    );
    const manifest = await fetchManifest(deploymentUrl);
    const compiled = Object.entries(manifest.workflows)
      .filter(([file]) => file.endsWith('104_scheduled.ts'))
      .map(([, fns]) => fns.e2eScheduledWorkflow?.workflowId)
      .filter(Boolean);
    expect(compiled).toContain(decoded);
    workflowId = decoded as string;
  });

  test(
    'running the schedule starts the workflow with the occurrence, once',
    { timeout: RUN_TIMEOUT_MS + 30_000 },
    async () => {
      expect(
        workflowId,
        'the schedule test above found no workflow'
      ).toBeDefined();
      const world = await getWorld();
      const listRuns = async () =>
        (
          await world.runs.list({
            workflowName: workflowId,
            pagination: { limit: 50 },
          })
        ).data;
      const before = new Set((await listRuns()).map((run) => run.runId));

      await schedulesApi(`/v1/schedules/${SCHEDULE_NAME}/invoke`, {
        method: 'POST',
      });

      // The occurrence reaches the flow route through Vercel Queues, which
      // starts the run: find the run it started.
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      let runId: string | undefined;
      while (!runId && Date.now() < deadline) {
        // The oldest new run: another lane's invoke can only add later ones.
        const started = (await listRuns())
          .filter((run) => !before.has(run.runId))
          .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
        runId = started[0]?.runId;
        if (!runId) await sleep(2_000);
      }
      expect(
        runId,
        'the schedule started no run of e2eScheduledWorkflow'
      ).toBeDefined();

      if (!runId) throw new Error('unreachable: expect() above failed');
      const result = (await getRun(runId).returnValue) as {
        name: string;
        namespace: string;
        source: string;
        executionId: string;
        scheduleId: string;
        scheduledAt: string;
        scheduledAtIsDate: boolean;
        hasPayload: boolean;
      };
      expect(result).toMatchObject({
        name: SCHEDULE_NAME,
        namespace: 'default',
        source: 'static',
        scheduledAtIsDate: true,
        hasPayload: false,
      });
      expect(Number.isNaN(Date.parse(result.scheduledAt))).toBe(false);

      // The run owns its occurrence's start token, which is what refuses a
      // second run for a redelivery of the same occurrence.
      const hook = await getHookByToken(
        `schedule:${result.scheduleId}:${result.executionId}`
      );
      expect(hook.runId).toBe(runId);

      // No occurrence started a second run. Other lanes testing the same
      // deployment can invoke the schedule too, so each new run is checked
      // by its occurrence rather than by counting runs.
      const started = (await listRuns()).filter(
        (run) => !before.has(run.runId)
      );
      const runsByOccurrence = new Map<string, string[]>();
      for (const run of started) {
        if (run.status !== 'completed') continue;
        const value = (await getRun(run.runId).returnValue) as {
          executionId: string;
        };
        runsByOccurrence.set(value.executionId, [
          ...(runsByOccurrence.get(value.executionId) ?? []),
          run.runId,
        ]);
      }
      expect(runsByOccurrence.get(result.executionId)).toEqual([runId]);
      for (const [executionId, ids] of runsByOccurrence) {
        expect(
          ids,
          `occurrence ${executionId} started more than one run`
        ).toHaveLength(1);
      }
    }
  );
});
