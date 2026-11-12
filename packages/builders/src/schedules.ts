import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { scheduleTopicForWorkflowName } from '@workflow/core/schedule-topic';
import type { WorkflowManifest } from './apply-swc-transform.js';

/**
 * Static schedules declared on workflows with `experimental_schedule`.
 *
 * The compiler copies each workflow's literal `experimental_schedule` into the
 * manifest. This reads it, validates it, and turns it into Build Output API
 * schedules (`config.json#schedules`) that publish to the workflow's schedule
 * topic, which the flow route consumes and starts the workflow from
 * (`@workflow/core/runtime/schedule`). The app needs no `vercel.json` entry.
 */

/** A schedule in Build Output API `config.json#schedules`, keyed by name. */
export interface BuildOutputSchedule {
  schedule: string;
  timezone?: string;
  jitter?: number;
  topic: string;
}

export type BuildOutputSchedules = Record<string, BuildOutputSchedule>;

const SCHEDULE_KEYS = new Set(['cron', 'timezone', 'jitter', 'name']);
/** Schedule names: 1 to 256 ASCII letters, digits, `.`, `_` and `-`, starting with a letter or digit. */
const SCHEDULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const CRON_FIELD = /^[A-Za-z0-9*,/-]+$/;

/** A schedule declaration the build cannot use, with where it was declared. */
export class WorkflowScheduleError extends Error {
  constructor(where: string, problem: string) {
    super(`Invalid experimental_schedule on ${where}: ${problem}`);
    this.name = 'WorkflowScheduleError';
  }
}

type ManifestWorkflowEntry = { workflowId: string; schedule?: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The default name of a workflow's only schedule: its export name, or the file's for a default export. */
function defaultScheduleName(file: string, exportName: string): string {
  const base =
    exportName === 'default'
      ? (file
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') ?? 'default')
      : exportName;
  const name = base
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '');
  return name.slice(0, 256) || 'workflow';
}

function validateOne(
  where: string,
  value: unknown,
  defaultName: string | undefined
): { name: string; schedule: Omit<BuildOutputSchedule, 'topic'> } {
  if (!isPlainObject(value)) {
    throw new WorkflowScheduleError(
      where,
      'expected an object like { cron: "0 2 * * *" }, or an array of them.'
    );
  }
  for (const key of Object.keys(value)) {
    if (!SCHEDULE_KEYS.has(key)) {
      throw new WorkflowScheduleError(
        where,
        `unknown property "${key}". Use cron, timezone, jitter, and name.`
      );
    }
  }
  const { cron, timezone, jitter, name } = value;
  if (typeof cron !== 'string' || !cron.trim()) {
    throw new WorkflowScheduleError(
      where,
      '`cron` must be a cron expression string, like "0 2 * * *".'
    );
  }
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
    throw new WorkflowScheduleError(
      where,
      `\`cron\` "${cron}" must have five fields: minute, hour, day of month, month, and day of week.`
    );
  }
  if (
    timezone !== undefined &&
    (typeof timezone !== 'string' || !isValidTimeZone(timezone))
  ) {
    throw new WorkflowScheduleError(
      where,
      `\`timezone\` ${JSON.stringify(timezone)} is not an IANA timezone, like "America/New_York".`
    );
  }
  if (
    jitter !== undefined &&
    (typeof jitter !== 'number' ||
      !Number.isInteger(jitter) ||
      jitter < 1 ||
      jitter > 15)
  ) {
    throw new WorkflowScheduleError(
      where,
      '`jitter` must be a whole number of minutes from 1 to 15.'
    );
  }
  if (
    name !== undefined &&
    (typeof name !== 'string' || !SCHEDULE_NAME.test(name))
  ) {
    throw new WorkflowScheduleError(
      where,
      `\`name\` ${JSON.stringify(name)} must be 1 to 256 letters, digits, ".", "_", or "-", starting with a letter or digit.`
    );
  }
  const resolvedName = (name as string | undefined) ?? defaultName;
  if (!resolvedName) {
    throw new WorkflowScheduleError(
      where,
      'every schedule in an array needs a `name`, so each one keeps its state across deployments.'
    );
  }
  return {
    name: resolvedName,
    schedule: {
      schedule: fields.join(' '),
      ...(timezone !== undefined ? { timezone: timezone as string } : {}),
      ...(jitter !== undefined ? { jitter: jitter as number } : {}),
    },
  };
}

/**
 * The Build Output schedules of every workflow in `manifest` that declares
 * `experimental_schedule`, keyed by schedule name. Throws a
 * {@link WorkflowScheduleError} naming the workflow for a declaration the
 * platform would refuse, and for two schedules with the same name.
 */
export function collectWorkflowSchedules(
  manifest: Pick<WorkflowManifest, 'workflows'>,
  options?: {
    namespace?: string;
    /**
     * Directories the manifest's file paths may be relative to. With them, a
     * file the build found under two paths (a symlink and its target, which
     * the builder keeps both of) is read once, under its real path.
     */
    roots?: string[];
  }
): BuildOutputSchedules {
  const schedules: BuildOutputSchedules = {};
  const declaredBy = new Map<string, string>();
  const files = canonicalFiles(
    Object.keys(manifest.workflows ?? {}),
    options?.roots
  );
  for (const file of files) {
    const entries = manifest.workflows?.[file] ?? {};
    for (const exportName of Object.keys(entries).sort()) {
      const entry = entries[exportName] as ManifestWorkflowEntry;
      if (entry.schedule === undefined) continue;
      const where = `workflow "${exportName}" in ${file}`;
      const declared = Array.isArray(entry.schedule)
        ? entry.schedule
        : [entry.schedule];
      if (declared.length === 0) {
        throw new WorkflowScheduleError(
          where,
          'the array is empty. Remove the property instead.'
        );
      }
      const topic = scheduleTopicForWorkflowName(
        entry.workflowId,
        options?.namespace
      );
      declared.forEach((value, index) => {
        const { name, schedule } = validateOne(
          declared.length > 1 ? `${where} (schedule ${index + 1})` : where,
          value,
          declared.length === 1
            ? defaultScheduleName(file, exportName)
            : undefined
        );
        const other = declaredBy.get(name);
        if (other) {
          throw new WorkflowScheduleError(
            where,
            `the schedule name "${name}" is also used by ${other}. Set a different \`name\`.`
          );
        }
        declaredBy.set(name, where);
        schedules[name] = { ...schedule, topic };
      });
    }
  }
  return schedules;
}

/**
 * The manifest's files, sorted, with each physical file once. A symlinked
 * workflow file is discovered under its link and under its target, with a
 * workflow ID for each. The bundle holds one module, under its real path, so
 * a path that goes through a link is dropped when the manifest also has the
 * file under a path its real path ends with.
 */
function canonicalFiles(
  files: string[],
  roots: string[] | undefined
): string[] {
  const sorted = [...files].sort();
  if (!roots?.length) return sorted;
  return sorted.filter((file) => {
    const absolute = roots
      .map((root) => resolve(root, file))
      .find((p) => existsSync(p));
    if (!absolute) return true;
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      return true;
    }
    if (real === absolute) return true;
    const normalizedReal = real.replace(/\\/g, '/');
    return !sorted.some(
      (other) =>
        other !== file &&
        normalizedReal.endsWith(`/${other.replace(/^\.\//, '')}`)
    );
  });
}

/**
 * Adds `schedules` to a Build Output API `config.json`, keeping everything
 * else in it. A schedule name the file already holds is an error, like a
 * name defined twice across `vercel.json` and the build. Does nothing when
 * there are no schedules.
 */
export async function writeBuildOutputSchedules(
  configPath: string,
  schedules: BuildOutputSchedules
): Promise<void> {
  if (Object.keys(schedules).length === 0) return;
  let source: string | undefined;
  try {
    source = await readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const config = withSchedules(configPath, source, schedules);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, config);
}

/** {@link writeBuildOutputSchedules}, synchronously, for a process exit hook. */
export function writeBuildOutputSchedulesSync(
  configPath: string,
  schedules: BuildOutputSchedules
): void {
  if (Object.keys(schedules).length === 0) return;
  let source: string | undefined;
  try {
    source = readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const config = withSchedules(configPath, source, schedules);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, config);
}

function withSchedules(
  configPath: string,
  source: string | undefined,
  schedules: BuildOutputSchedules
): string {
  const config: Record<string, unknown> =
    source === undefined ? { version: 3 } : JSON.parse(source);
  const existing = isPlainObject(config.schedules) ? config.schedules : {};
  for (const name of Object.keys(schedules)) {
    if (name in existing) {
      throw new WorkflowScheduleError(
        `schedule "${name}"`,
        `${configPath} already defines a schedule with this name. Set a different \`name\`.`
      );
    }
  }
  config.schedules = { ...existing, ...schedules };
  return `${JSON.stringify(config, null, 2)}\n`;
}
