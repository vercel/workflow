import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Helm chart in `chart/`, rendered with `helm template`. Skipped where
 * helm is not installed.
 */
const chart = fileURLToPath(new URL('../chart', import.meta.url));
const hasHelm =
  spawnSync('helm', ['version'], { stdio: 'ignore' }).status === 0;
const SHA = 'a'.repeat(40);

function render(sets: Record<string, string>) {
  const args = ['template', 'rel', chart, '--namespace', 'apps'];
  for (const [key, value] of Object.entries({
    serviceName: 'billing',
    'image.repository': 'registry.example/billing',
    'image.tag': SHA,
    ...sets,
  })) {
    args.push('--set', `${key}=${value}`);
  }
  return spawnSync('helm', args, { encoding: 'utf8' });
}

/** One rendered document, failing when it is missing. */
function get(docs: Map<string, string>, key: string): string {
  const doc = docs.get(key);
  if (doc === undefined) throw new Error(`${key} was not rendered`);
  return doc;
}

/** The rendered documents, by `kind/name`. */
function documents(sets: Record<string, string> = {}) {
  const result = render(sets);
  if (result.status !== 0) throw new Error(result.stderr);
  const docs = new Map<string, string>();
  for (const doc of result.stdout.split(/^---$/m)) {
    const kind = /^kind: (\S+)/m.exec(doc)?.[1];
    const name = /^ {2}name: (\S+)/m.exec(doc)?.[1];
    if (kind && name) docs.set(`${kind}/${name}`, doc);
  }
  return docs;
}

describe.skipIf(!hasHelm)('Helm chart', () => {
  it('lints', () => {
    expect(() =>
      execFileSync('helm', [
        'lint',
        chart,
        '--set',
        `serviceName=billing,image.repository=r/billing,image.tag=${SHA}`,
      ])
    ).not.toThrow();
  });

  it('configures world-postgres from the release: job prefix, pinned deployment, role', () => {
    const docs = documents();
    const main = get(docs, 'Deployment/billing');
    expect(main).toMatch(
      /- name: WORKFLOW_ROLE\s+value: service\s+- name: PORT\s+value: "3000"\s+- name: WORKFLOW_POSTGRES_JOB_PREFIX\s+value: "billing_"\s+- name: WORKFLOW_POSTGRES_DEPLOYMENT_ID\s+value: "a{40}"/
    );
    expect(main).toContain(`app.kubernetes.io/version: "${SHA}"`);
    const worker = get(docs, `Deployment/billing-wf-${SHA}`);
    expect(worker).toContain('helm.sh/resource-policy: keep');
    expect(worker).toMatch(/- name: WORKFLOW_ROLE\s+value: worker/);
    expect(worker).toContain('workflow.vercel.com/service: billing');
    expect(worker).toContain(`workflow.vercel.com/version: "${SHA}"`);
  });

  it('scales a version’s workers on its backlog and prunes drained versions', () => {
    const docs = documents({
      backlogPath: '/wf',
      'versionPinning.prune.command': '{node,prune.js,--in-cluster}',
    });
    const scaled = get(docs, `ScaledObject/billing-wf-${SHA}`);
    expect(scaled).toContain('helm.sh/resource-policy: keep');
    expect(scaled).toContain('minReplicaCount: 0');
    expect(scaled).toContain(
      `url: "http://billing.apps.svc.cluster.local/wf/backlog/${SHA}"`
    );
    expect(scaled).toContain('valueLocation: wanted');
    const prune = get(docs, 'CronJob/billing-workflow-prune');
    expect(prune).toMatch(/- name: WORKFLOW_PRUNE_SERVICE\s+value: "billing"/);
    expect(prune).toMatch(
      /- name: WORKFLOW_PRUNE_BACKLOG_URL\s+value: "http:\/\/billing\.apps\.svc\.cluster\.local\/wf"/
    );
    expect(prune).toMatch(/command:\s+- node\s+- prune\.js\s+- --in-cluster/);
    expect(prune).toContain('serviceAccountName: billing-workflow-prune');
    // The prune job has no database settings: it reads the service.
    expect(prune).not.toContain('WORKFLOW_POSTGRES');
    const role = get(docs, 'Role/billing-workflow-prune');
    expect(role).not.toContain('secrets');
  });

  it('runs migrations in an init container of every pod when enabled', () => {
    const docs = documents({
      'migrations.enabled': 'true',
      'migrations.command': '{node,setup.js}',
      'env.WORKFLOW_POSTGRES_URL': 'postgres://db',
    });
    for (const name of ['billing', `billing-wf-${SHA}`]) {
      expect(docs.get(`Deployment/${name}`)).toMatch(
        /initContainers:\s+- name: migrate[\s\S]*command:\s+- node\s+- setup\.js[\s\S]*WORKFLOW_POSTGRES_URL/
      );
    }
    expect(documents().get('Deployment/billing')).not.toContain(
      'initContainers'
    );
  });

  it('runs unpinned runs on an opt-in worker without a deployment ID, outside pruning', () => {
    expect(documents().has('Deployment/billing-wf-unpinned')).toBe(false);
    const docs = documents({
      'unpinnedWorker.enabled': 'true',
      'unpinnedWorker.replicas': '2',
    });
    const unpinned = get(docs, 'Deployment/billing-wf-unpinned');
    expect(unpinned).toContain('replicas: 2');
    expect(unpinned).toContain('workflow.vercel.com/role: unpinned-worker');
    expect(unpinned).not.toContain('workflow.vercel.com/role: worker');
    expect(unpinned).not.toContain('helm.sh/resource-policy');
    expect(unpinned).toMatch(
      /- name: WORKFLOW_ROLE\s+value: worker\s+- name: PORT\s+value: "3000"\s+- name: WORKFLOW_POSTGRES_JOB_PREFIX\s+value: "billing_"/
    );
    expect(unpinned).not.toContain('WORKFLOW_POSTGRES_DEPLOYMENT_ID');
  });

  it('renders no workers or prune job without version pinning', () => {
    const docs = documents({ 'versionPinning.enabled': 'false' });
    expect([...docs.keys()].sort()).toEqual([
      'Deployment/billing',
      'Service/billing',
      'ServiceAccount/billing',
    ]);
    expect(docs.get('Deployment/billing')).not.toContain(
      'WORKFLOW_POSTGRES_DEPLOYMENT_ID'
    );
  });

  it.each([
    [{ 'image.tag': 'postgres' }, /reserved for unpinned runs/],
    [{ 'image.tag': 'v1/2' }, /may use only/],
    [{ 'image.tag': 'a'.repeat(41) }, /at most 40 characters/],
    [{ jobPrefix: 'p'.repeat(50) }, /at most 81 characters/],
    [{ serviceName: 'Billing' }, /DNS label/],
    [{ 'image.tag': 'Abc1234' }, /may use only lowercase/],
    [{ 'image.tag': 'a@b' }, /may use only lowercase/],
    [{ 'image.tag': '-abc' }, /may use only lowercase/],
    [{ 'image.tag': '1234567' }, /must be a string/],
    [{ 'migrations.enabled': 'true' }, /migrations.command is required/],
  ])('refuses %o', (sets, message) => {
    const result = render(sets as Record<string, string>);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
  });

  it('keeps the prune CronJob within 52 characters for the longest service name', () => {
    const serviceName = `${'b'.repeat(62)}x`;
    // A short jobPrefix: the default (the service name) is too long for Graphile with a SHA tag.
    const docs = documents({ serviceName, jobPrefix: 'b_' });
    const cronJob = [...docs.keys()].find((key) => key.startsWith('CronJob/'));
    expect(cronJob).toBeDefined();
    expect(
      (cronJob as string).slice('CronJob/'.length).length
    ).toBeLessThanOrEqual(52);
  });
});
