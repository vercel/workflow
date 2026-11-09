import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectWorkflowSchedules,
  WorkflowScheduleError,
  writeBuildOutputSchedules,
  writeBuildOutputSchedulesSync,
} from './schedules.js';

const NIGHTLY_ID = 'workflow//./workflows/nightly-report//nightlyReport';
const NIGHTLY_TOPIC =
  '__wkf_workflow_schedule_workflows_snightly-report__nightlyReport';

function manifestWith(schedule: unknown, exportName = 'nightlyReport') {
  return {
    workflows: {
      'workflows/nightly-report.ts': {
        [exportName]: {
          workflowId: `workflow//./workflows/nightly-report//${exportName}`,
          schedule,
        },
      },
    },
  };
}

describe('collectWorkflowSchedules', () => {
  it('turns a workflow schedule into a Build Output schedule on its topic', () => {
    expect(
      collectWorkflowSchedules(
        manifestWith({
          cron: '0 2 * * *',
          timezone: 'America/New_York',
          jitter: 5,
        })
      )
    ).toEqual({
      nightlyReport: {
        schedule: '0 2 * * *',
        timezone: 'America/New_York',
        jitter: 5,
        topic: NIGHTLY_TOPIC,
      },
    });
  });

  it('names a single schedule after the workflow, unless it sets a name', () => {
    expect(
      Object.keys(collectWorkflowSchedules(manifestWith({ cron: '0 2 * * *' })))
    ).toEqual(['nightlyReport']);
    expect(
      Object.keys(
        collectWorkflowSchedules(
          manifestWith({ cron: '0 2 * * *', name: 'nightly.report-v2' })
        )
      )
    ).toEqual(['nightly.report-v2']);
  });

  it('names a default export after its file', () => {
    expect(
      Object.keys(
        collectWorkflowSchedules(manifestWith({ cron: '0 2 * * *' }, 'default'))
      )
    ).toEqual(['nightly-report']);
  });

  it('keeps several named schedules for one workflow, all on its topic', () => {
    const schedules = collectWorkflowSchedules(
      manifestWith([
        { cron: '0 9 * * 1-5', name: 'weekday' },
        { cron: '0 11  * * 0,6', name: 'weekend', jitter: 15 },
      ])
    );
    expect(schedules).toEqual({
      weekday: { schedule: '0 9 * * 1-5', topic: NIGHTLY_TOPIC },
      weekend: { schedule: '0 11 * * 0,6', jitter: 15, topic: NIGHTLY_TOPIC },
    });
  });

  it('follows the queue namespace', () => {
    expect(
      collectWorkflowSchedules(manifestWith({ cron: '0 2 * * *' }), {
        namespace: 'acme',
      }).nightlyReport.topic
    ).toBe(
      `__acme_wkf_workflow_schedule_workflows_snightly-report__nightlyReport`
    );
  });

  it('emits nothing for workflows without a schedule', () => {
    expect(
      collectWorkflowSchedules({
        workflows: { 'a.ts': { a: { workflowId: 'workflow//./a//a' } } },
      })
    ).toEqual({});
    expect(collectWorkflowSchedules({})).toEqual({});
  });

  it.each([
    [{ cron: '0 2 * * *', every: 'day' }, /unknown property "every"/],
    [{ schedule: '0 2 * * *' }, /unknown property "schedule"/],
    [{ timezone: 'UTC' }, /`cron` must be a cron expression/],
    [{ cron: '0 2 * *' }, /must have five fields/],
    [{ cron: '0 2 * * * *' }, /must have five fields/],
    [{ cron: '0 2 * * $' }, /must have five fields/],
    [{ cron: '0 2 * * *', timezone: 'Mars/Olympus' }, /not an IANA timezone/],
    [{ cron: '0 2 * * *', jitter: 0 }, /from 1 to 15/],
    [{ cron: '0 2 * * *', jitter: 16 }, /from 1 to 15/],
    [{ cron: '0 2 * * *', jitter: 2.5 }, /from 1 to 15/],
    [{ cron: '0 2 * * *', name: '-leading' }, /`name` "-leading"/],
    [{ cron: '0 2 * * *', name: 'has space' }, /`name` "has space"/],
    ['0 2 * * *', /expected an object/],
    [[], /the array is empty/],
    [
      [{ cron: '0 2 * * *' }, { cron: '0 3 * * *', name: 'b' }],
      /needs a `name`/,
    ],
  ])('refuses %j, naming the workflow', (schedule, message) => {
    expect(() => collectWorkflowSchedules(manifestWith(schedule))).toThrow(
      WorkflowScheduleError
    );
    expect(() => collectWorkflowSchedules(manifestWith(schedule))).toThrow(
      message
    );
    expect(() => collectWorkflowSchedules(manifestWith(schedule))).toThrow(
      /workflow "nightlyReport" in workflows\/nightly-report\.ts/
    );
  });

  it('refuses two schedules with the same name, across files', () => {
    expect(() =>
      collectWorkflowSchedules({
        workflows: {
          'a/report.ts': {
            report: {
              workflowId: 'workflow//./a/report//report',
              schedule: { cron: '0 1 * * *' },
            },
          },
          'b/report.ts': {
            report: {
              workflowId: 'workflow//./b/report//report',
              schedule: { cron: '0 2 * * *' },
            },
          },
        },
      })
    ).toThrow(/"report" is also used by workflow "report" in a\/report\.ts/);
  });
});

describe('writeBuildOutputSchedules', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-schedules-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const schedules = {
    nightlyReport: { schedule: '0 2 * * *', topic: NIGHTLY_TOPIC },
  };

  it('adds schedules to a config.json and keeps the rest of it', async () => {
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 3,
        routes: [{ handle: 'filesystem' }],
        schedules: {
          cleanup: { schedule: '0 3 * * *', function: 'api/cleanup' },
        },
      })
    );
    await writeBuildOutputSchedules(configPath, schedules);
    expect(JSON.parse(await readFile(configPath, 'utf-8'))).toEqual({
      version: 3,
      routes: [{ handle: 'filesystem' }],
      schedules: {
        cleanup: { schedule: '0 3 * * *', function: 'api/cleanup' },
        ...schedules,
      },
    });
  });

  it('creates the file when there is none', async () => {
    const configPath = join(dir, 'nested/config.json');
    writeBuildOutputSchedulesSync(configPath, schedules);
    expect(JSON.parse(await readFile(configPath, 'utf-8'))).toEqual({
      version: 3,
      schedules,
    });
  });

  it('refuses a name the config already holds', async () => {
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 3,
        schedules: { nightlyReport: { schedule: '0 1 * * *', path: '/x' } },
      })
    );
    await expect(
      writeBuildOutputSchedules(configPath, schedules)
    ).rejects.toThrow(/already defines a schedule with this name/);
  });

  it('leaves the file alone when there are no schedules', async () => {
    const configPath = join(dir, 'config.json');
    await writeBuildOutputSchedules(configPath, {});
    await expect(readFile(configPath, 'utf-8')).rejects.toThrow(/ENOENT/);
  });
});

describe('the compiled workflow id', () => {
  it('is the id the topic encodes', () => {
    expect(
      collectWorkflowSchedules({
        workflows: {
          'workflows/nightly-report.ts': {
            nightlyReport: {
              workflowId: NIGHTLY_ID,
              schedule: { cron: '0 2 * * *' },
            },
          },
        },
      }).nightlyReport.topic
    ).toBe(NIGHTLY_TOPIC);
  });
});

describe('a workflow file found under a symlink and its target', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wf-schedules-link-'));
    await mkdir(join(root, 'shared'), { recursive: true });
    await mkdir(join(root, 'app/workflows'), { recursive: true });
    await writeFile(join(root, 'shared/report.ts'), '');
    await symlink(
      '../../shared/report.ts',
      join(root, 'app/workflows/report.ts')
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const entry = (dir: string) => ({
    report: {
      workflowId: `workflow//./${dir}/report//report`,
      schedule: { cron: '0 2 * * *' },
    },
  });

  it('is read once, under its real path', () => {
    const manifest = {
      workflows: {
        'app/workflows/report.ts': entry('app/workflows'),
        'shared/report.ts': entry('shared'),
      },
    };
    expect(collectWorkflowSchedules(manifest, { roots: [root] })).toEqual({
      report: {
        schedule: '0 2 * * *',
        topic: '__wkf_workflow_schedule_shared_sreport__report',
      },
    });
    // Without roots there is no way to tell, and the name is a duplicate.
    expect(() => collectWorkflowSchedules(manifest)).toThrow(/is also used by/);
  });
});
