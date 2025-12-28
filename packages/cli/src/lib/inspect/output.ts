import { hydrateResourceIO } from '@workflow/core/observability';
import { parseStepName, parseWorkflowName } from '@workflow/core/parse-name';
import {
  getDeserializeStream,
  getExternalRevivers,
} from '@workflow/core/serialization';
import { VERCEL_403_ERROR_MESSAGE } from '@workflow/errors';
import type {
  Event,
  Hook,
  ListEventsParams,
  PaginationOptions,
  Step,
  WorkflowRun,
  World,
} from '@workflow/world';
import chalk from 'chalk';
import { formatDistance } from 'date-fns';
import Table from 'easy-table';
import { logger } from '../config/log.js';
import type { InspectCLIOptions } from '../config/types.js';
import { setupListPagination } from './pagination.js';
import { streamToConsole } from './stream.js';
import {
  formatISODate,
  formatStatus as formatStatusAbbrev,
  getDisplaySettings,
  getTerminalWidth,
  isCI,
} from './terminal-utils.js';

const DEFAULT_PAGE_SIZE = 20;
let TABLE_TRUNCATE_IO_LENGTH = 15; // Will be adjusted based on terminal width

const WORKFLOW_RUN_IO_PROPS: (keyof WorkflowRun)[] = ['input', 'output'];

const STEP_IO_PROPS: (keyof Step)[] = ['input', 'output'];

const WORKFLOW_RUN_LISTED_PROPS: (keyof WorkflowRun)[] = [
  'runId',
  'workflowName',
  'status',
  'startedAt',
  'completedAt',
  ...WORKFLOW_RUN_IO_PROPS,
];

const STEP_LISTED_PROPS: (keyof Step)[] = [
  'runId',
  'stepId',
  'stepName',
  'status',
  'startedAt',
  'completedAt',
  ...STEP_IO_PROPS,
];

const EVENT_IO_PROPS: (keyof Event | 'eventData')[] = ['eventData'];

const EVENT_LISTED_PROPS: (keyof Event | 'eventData')[] = [
  'eventId',
  'eventType',
  'correlationId',
  'createdAt',
  ...EVENT_IO_PROPS,
];

// const HOOK_DATA_PROPS: (keyof Hook | 'hasResponse')[] = ['hasResponse'];

const HOOK_LISTED_PROPS: (keyof Hook | 'hasResponse')[] = [
  'runId',
  'hookId',
  'ownerId',
  'createdAt',
  // ...HOOK_DATA_PROPS,
];

interface Sleep {
  correlationId: string;
  runId: string;
  eventId: string;
  createdAt: Date;
  resumeAt: Date | undefined;
  completedAt: Date | undefined;
}

const WAIT_LISTED_PROPS: (keyof Sleep)[] = [
  'correlationId',
  'eventId',
  'createdAt',
  'resumeAt',
  'completedAt',
];

const STATUS_COLORS: Record<
  WorkflowRun['status'] | Step['status'],
  (value: string) => string
> = {
  running: chalk.blue,
  completed: chalk.green,
  failed: chalk.red,
  cancelled: chalk.strikethrough.yellow,
  pending: chalk.blue,
  paused: chalk.yellow,
};

const isStreamId = (value: string) => {
  return typeof value === 'string' && value.startsWith('strm_');
};

const showStatusLegend = () => {
  logger.log('\nStatus Legend:');
  const statuses: Array<WorkflowRun['status'] | Step['status']> = [
    'running',
    'completed',
    'failed',
    'cancelled',
    'pending',
    'paused',
  ];

  const legendItems = statuses.map((status) => {
    const colorFunc = STATUS_COLORS[status];
    const abbrev = formatStatusAbbrev(status, true);
    return `${colorFunc(abbrev)} = ${status}`;
  });

  logger.log(`  ${legendItems.join('  ')}`);
  logger.log('');
};

const isSleepStep = (stepName: string) => {
  return stepName.includes('-sleep');
};

const checkAndHandleVercelAccessError = (
  error: unknown,
  backend?: string
): boolean => {
  if (backend === 'vercel' && error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (err.status === 403) {
      logger.error(VERCEL_403_ERROR_MESSAGE);
      return true;
    }
  }
  return false;
};

const extractErrorMessage = (
  err: Record<string, unknown>
): string | undefined => {
  if (err.message && typeof err.message === 'string') {
    return err.message;
  }

  if (err.body && typeof err.body === 'object') {
    const body = err.body as Record<string, unknown>;
    if (body.message && typeof body.message === 'string') {
      return body.message;
    }
    if (body.error && typeof body.error === 'string') {
      return body.error;
    }
  }

  return undefined;
};

const handleApiError = (error: unknown, backend?: string): boolean => {
  // First check for Vercel access errors
  if (checkAndHandleVercelAccessError(error, backend)) {
    return true;
  }

  // Handle other HTTP errors
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // Handle 400 Bad Request
    if (err.status === 400) {
      logger.error('Bad Request: The request was invalid.');
      const message = extractErrorMessage(err);
      if (message) {
        logger.error(`Details: ${message}`);
      }
      return true;
    }

    // Handle other HTTP errors (404, 500, etc.)
    if (typeof err.status === 'number' && err.status >= 400) {
      logger.error(`HTTP Error ${err.status}: ${getStatusText(err.status)}`);
      const message = extractErrorMessage(err);
      if (message) {
        logger.error(`Details: ${message}`);
      }
      return true;
    }
  }

  return false;
};

const getStatusText = (status: number): string => {
  const statusTexts: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return statusTexts[status] || 'Unknown Error';
};

const truncateNameIfNeeded = (name: string, maxLength: number): string => {
  return maxLength < name.length ? `${name.substring(0, maxLength)}...` : name;
};

const formatNameField = (
  nameNonUnique: string,
  truncateLength: number,
  isSleep: boolean
): string => {
  const truncatedName = truncateNameIfNeeded(nameNonUnique, truncateLength);
  if (isSleep) {
    return chalk.yellowBright(truncatedName);
  }
  return chalk.blue.blueBright(truncatedName);
};

const formatIdField = (
  prop: string,
  value: unknown,
  shouldTruncateIds: boolean
): string | undefined => {
  const valueStr = String(value);
  const idStr = shouldTruncateIds ? truncateIdToLastChars(valueStr) : valueStr;
  if (prop === 'streamId') {
    return chalk.green(idStr);
  }
  return idStr;
};

const formatTableValue = (
  prop: string,
  value: unknown,
  opts: InspectCLIOptions = {},
  displaySettings?: ReturnType<typeof getDisplaySettings>,
  item?: Record<string, unknown>
) => {
  const namesTruncate = displaySettings?.namesTruncateLength ?? 40;
  const shouldTruncateIds = displaySettings?.truncateIdsToLastChars ?? false;

  // Handle IDs with potential truncation
  if (
    [
      'streamId',
      'runId',
      'stepId',
      'hookId',
      'eventId',
      'correlationId',
      'ownerId',
    ].includes(prop)
  ) {
    return formatIdField(prop, value, shouldTruncateIds);
  }

  // Handle names with truncation
  if (prop === 'stepName') {
    const nameNonUnique = parseStepName(String(value))?.shortName || '?';
    return formatNameField(
      nameNonUnique,
      namesTruncate,
      isSleepStep(String(value))
    );
  }

  if (prop === 'workflowName') {
    const nameNonUnique = parseWorkflowName(String(value))?.shortName || '?';
    const truncatedName = truncateNameIfNeeded(nameNonUnique, namesTruncate);
    return chalk.blue.blueBright(truncatedName);
  }

  if (prop === 'output' || prop === 'input' || prop === 'error') {
    // Check if data has expired
    if (item && 'expiredAt' in item && item.expiredAt != null) {
      return EXPIRED_DATA_MESSAGE;
    }
    return inlineFormatIO(value);
  }

  if (prop === 'status') {
    const status = value as WorkflowRun['status'] | Step['status'];
    const colorFunc = STATUS_COLORS[status];
    const formattedStatus = displaySettings?.abbreviateStatus
      ? formatStatusAbbrev(status, true)
      : status;
    return colorFunc(formattedStatus);
  }

  if (prop === 'eventData') {
    return truncateString(JSON.stringify(value));
  }

  if (prop === 'hasResponse') {
    return value ? chalk.green('true') : chalk.gray('false');
  }

  if (value instanceof Date) {
    return formatTableTimestamp(value, opts, displaySettings);
  }

  return value;
};

const getVisibleProps = (
  props: string[],
  displaySettings: ReturnType<typeof getDisplaySettings>
): string[] => {
  if (displaySettings.hideCompletedAt) {
    return props.filter((prop) => prop !== 'completedAt');
  }
  return props;
};

const showTable = (
  data: Record<string, unknown>[],
  props: string[],
  opts: InspectCLIOptions = {}
) => {
  // Get display settings based on terminal width
  const terminalWidth = getTerminalWidth();
  const displaySettings = getDisplaySettings(
    terminalWidth,
    opts.withData || false,
    props.includes('runName')
  );

  // Filter out completedAt column if needed
  const visibleProps = getVisibleProps(props, displaySettings);

  // Update truncate length for IO fields
  const originalTruncateLength = TABLE_TRUNCATE_IO_LENGTH;
  TABLE_TRUNCATE_IO_LENGTH = displaySettings.dataFieldWidth;

  // Show status legend if using abbreviated status
  if (
    data.length > 0 &&
    displaySettings.abbreviateStatus &&
    visibleProps.includes('status')
  ) {
    showStatusLegend();
  }

  // Create header mapping for abbreviated status
  const headerMap: Record<string, string> = {};
  if (displaySettings.abbreviateStatus && visibleProps.includes('status')) {
    headerMap['status'] = 'S';
  }

  // Add a blank line before any table
  const table = new Table();
  if (data && data.length === 0) {
    logger.warn('No data found for this query and resource.\n');
    for (const prop of visibleProps) {
      const header = headerMap[prop] || prop;
      table.cell(header, 'N/A');
    }
    table.newRow();
    // Restore original truncate length
    TABLE_TRUNCATE_IO_LENGTH = originalTruncateLength;
    return table.toString();
  } else if (!data) {
    logger.warn('Expecting an array of data, but got null.\n');
  }
  logger.log('');
  for (const item of data) {
    for (const prop of visibleProps) {
      const header = headerMap[prop] || prop;
      const value = item[prop];
      table.cell(
        header,
        formatTableValue(prop, value, opts, displaySettings, item)
      );
    }
    table.newRow();
  }

  // Restore original truncate length
  TABLE_TRUNCATE_IO_LENGTH = originalTruncateLength;
  return table.toString();
};

const showJson = (data: unknown) => {
  const json = JSON.stringify(data, null, 2);
  process.stdout.write(`${json}\n`);
};

/**
 * In tables, we want to show a shorter timestamp, YYYY-MM-DD HH:MM:SS
 */
const formatTableTimestamp = (
  value: Date,
  opts: InspectCLIOptions = {},
  displaySettings?: ReturnType<typeof getDisplaySettings>
) => {
  // Format ISO time without T and Z
  const isoTime = formatISODate(value);

  // Show relative time only if:
  // - Not in CI mode
  // - Display settings allow it (based on terminal width)
  // - withData is disabled (more space available)
  // - Not in JSON mode
  // - disableRelativeDates is not set
  const shouldShowRelative =
    !isCI() &&
    displaySettings?.showRelativeDates !== false &&
    !opts.withData &&
    !opts.json &&
    !opts.disableRelativeDates;

  if (shouldShowRelative) {
    const relative = formatDistance(value, new Date(), { addSuffix: true });
    return `${isoTime} (${relative})`;
  }

  return isoTime;
};

const truncateString = (
  str: string,
  maxLength: number = TABLE_TRUNCATE_IO_LENGTH
) => {
  return str && str.length > maxLength
    ? `${str.substring(0, maxLength)}...`
    : str;
};

const truncateIdToLastChars = (id: string, chars: number = 4): string => {
  if (!id || id.length <= chars) return id;
  return `...${id.substring(id.length - chars)}`;
};

const showInspectInfoBox = (resource: string) => {
  logger.info(
    `To view details for a ${resource}, use \`workflow inspect ${resource}\` <id>`
  );
  logger.info(
    `To view the content of any stream, use \`workflow inspect stream <stream-id>\``
  );
};

const EXPIRED_DATA_MESSAGE = chalk.gray('<data expired>');

/**
 * Checks if a run has expired data storage
 */
const hasExpiredData = (run: WorkflowRun): boolean => {
  return 'expiredAt' in run && run.expiredAt != null;
};

/**
 * Takes hydrated step/workflow input/output and serializes it for inline display.
 */
const inlineFormatIO = <T>(io: T, topLevel: boolean = true): string => {
  const type = typeof io;
  let value = '';
  if (io === undefined) {
    value = '<empty>';
  } else if (io === null) {
    value = '<null>';
  } else if (io && Array.isArray(io)) {
    if (io.length === 0) {
      value = '<empty>';
    } else {
      const stringified = io
        .map((item) => inlineFormatIO(item, false))
        .join(',');
      if (stringified.length > TABLE_TRUNCATE_IO_LENGTH && topLevel) {
        value = chalk.yellow(`${io.length} args`);
      } else {
        value = stringified;
      }
    }
  } else if (type === 'object') {
    if (io instanceof Date) {
      value = io.toISOString();
    } else {
      value = truncateString(JSON.stringify(io));
    }
  } else if (['string', 'number', 'boolean'].includes(type)) {
    if (isStreamId(io as string)) {
      value = io.toString();
    } else if (type === 'string' && (io as string).includes('strm_')) {
      value = io as string;
    } else {
      value = truncateString(String(io));
    }
  } else {
    value = `<${type}>`;
  }
  return value;
};

export const listRuns = async (world: World, opts: InspectCLIOptions = {}) => {
  if (opts.stepId || opts.runId) {
    logger.warn(
      'Filtering by step-id or run-id is not supported in list calls, ignoring filter.'
    );
  }

  const resolveData = opts.withData ? 'all' : 'none';

  // Determine which props to show based on withData flag
  const props = opts.withData
    ? WORKFLOW_RUN_LISTED_PROPS
    : WORKFLOW_RUN_LISTED_PROPS.filter(
        (prop) => !WORKFLOW_RUN_IO_PROPS.includes(prop)
      );

  // For JSON output, just fetch once and return
  if (opts.json) {
    try {
      const runs = await world.runs.list({
        workflowName: opts.workflowName,
        pagination: {
          sortOrder: opts.sort || 'desc',
          cursor: opts.cursor,
          limit: opts.limit || DEFAULT_PAGE_SIZE,
        },
        resolveData,
      });
      const runsWithHydratedIO = runs.data.map(hydrateResourceIO);
      showJson({ ...runs, data: runsWithHydratedIO });
      return;
    } catch (error) {
      if (handleApiError(error, opts.backend)) {
        process.exit(1);
      }
      throw error;
    }
  }

  await setupListPagination<WorkflowRun>({
    initialCursor: opts.cursor,
    interactive: opts.interactive,
    fetchPage: async (cursor) => {
      try {
        const runs = await world.runs.list({
          workflowName: opts.workflowName,
          pagination: {
            sortOrder: opts.sort || 'desc',
            cursor,
            limit: opts.limit || DEFAULT_PAGE_SIZE,
          },
          resolveData,
        });
        return {
          data: runs.data,
          cursor: runs.cursor,
          hasMore: runs.hasMore,
        };
      } catch (error) {
        if (handleApiError(error, opts.backend)) {
          process.exit(1);
        }
        throw error;
      }
    },
    displayPage: async (runs) => {
      const runsWithHydratedIO = runs.map(hydrateResourceIO);
      logger.log(showTable(runsWithHydratedIO, props, opts));
    },
  });
};

export const getRecentRun = async (
  world: World,
  opts: InspectCLIOptions = {}
) => {
  logger.warn(`No runId provided, fetching data for latest run instead.`);
  try {
    const runs = await world.runs.list({
      pagination: { limit: 1, sortOrder: opts.sort || 'desc' },
      resolveData: 'none', // Don't need data for just getting the ID
    });
    runs.data = runs.data.map(hydrateResourceIO);
    return runs.data[0];
  } catch (error) {
    if (handleApiError(error, opts.backend)) {
      process.exit(1);
    }
    throw error;
  }
};

export const showRun = async (
  world: World,
  runId: string,
  opts: InspectCLIOptions = {}
) => {
  if (opts.withData) {
    logger.warn('`withData` flag is ignored when showing individual resources');
  }
  try {
    const run = await world.runs.get(runId, { resolveData: 'all' });
    const runWithHydratedIO = hydrateResourceIO(run);
    if (opts.json) {
      showJson(runWithHydratedIO);
      return;
    } else {
      if (hasExpiredData(run)) {
        logger.warn(
          "This run's data (input/output/error) has expired and is no longer available."
        );
      }
      logger.log(runWithHydratedIO);
    }
  } catch (error) {
    if (handleApiError(error, opts.backend)) {
      process.exit(1);
    }
    throw error;
  }
};

export const listSteps = async (
  world: World,
  opts: InspectCLIOptions = {
    runId: undefined,
  }
) => {
  if (opts.stepId) {
    logger.warn(
      'Filtering by step-id is not supported in list calls, ignoring filter.'
    );
  }
  if (opts.workflowName) {
    logger.warn(
      'Filtering by workflow-name is not supported for steps, ignoring filter.'
    );
  }

  const runId = opts.runId
    ? opts.runId
    : (await getRecentRun(world, opts))?.runId;
  if (!runId) {
    logger.error('No run found.');
    return;
  }

  const resolveData = opts.withData ? 'all' : 'none';

  // Determine which props to show based on withData flag
  const props = opts.withData
    ? STEP_LISTED_PROPS
    : STEP_LISTED_PROPS.filter((prop) => !STEP_IO_PROPS.includes(prop));

  // For JSON output, just fetch once and return
  if (opts.json) {
    logger.debug(`Fetching steps for run ${runId}`);
    try {
      const stepChunks = await world.steps.list({
        runId,
        pagination: {
          sortOrder: opts.sort || 'desc',
          cursor: opts.cursor,
          limit: opts.limit || DEFAULT_PAGE_SIZE,
        },
        resolveData,
      });
      showJson(stepChunks.data);
      return;
    } catch (error) {
      if (handleApiError(error, opts.backend)) {
        process.exit(1);
      }
      throw error;
    }
  }

  await setupListPagination<Step>({
    initialCursor: opts.cursor,
    interactive: opts.interactive,
    fetchPage: async (cursor) => {
      logger.debug(`Fetching steps for run ${runId}`);
      try {
        const stepChunks = await world.steps.list({
          runId,
          pagination: {
            sortOrder: opts.sort || 'desc',
            cursor,
            limit: opts.limit || DEFAULT_PAGE_SIZE,
          },
          resolveData,
        });
        return {
          data: stepChunks.data,
          cursor: stepChunks.cursor,
          hasMore: stepChunks.hasMore,
        };
      } catch (error) {
        if (handleApiError(error, opts.backend)) {
          process.exit(1);
        }
        throw error;
      }
    },
    displayPage: async (steps) => {
      const stepsWithHydratedIO = steps.map(hydrateResourceIO);
      logger.log(showTable(stepsWithHydratedIO, props, opts));
      showInspectInfoBox('step');
    },
  });
};

export const showStep = async (
  world: World,
  stepId: string,
  opts: InspectCLIOptions = {}
) => {
  if (opts.withData) {
    logger.warn('`withData` flag is ignored when showing individual resources');
  }
  if (opts.stepId) {
    logger.warn(
      'Filtering by step-id is not supported in get calls, ignoring filter.'
    );
  }
  try {
    const step = await world.steps.get(opts.runId, stepId, {
      resolveData: 'all',
    });
    const stepWithHydratedIO = hydrateResourceIO(step);
    if (opts.json) {
      showJson(stepWithHydratedIO);
      return;
    } else {
      logger.log(stepWithHydratedIO);
    }
  } catch (error) {
    if (handleApiError(error, opts.backend)) {
      process.exit(1);
    }
    throw error;
  }
};

export const showStream = async (
  world: World,
  streamId: string,
  opts: InspectCLIOptions = {}
) => {
  if (opts.runId || opts.stepId) {
    logger.warn(
      'Filtering by run-id or step-id is not supported when showing a stream, ignoring filter.'
    );
  }
  const rawStream = await world.readFromStream(streamId);

  // Deserialize the stream to get JavaScript objects
  const revivers = getExternalRevivers(globalThis, [], '');
  const transform = getDeserializeStream(revivers);
  const stream = rawStream.pipeThrough(transform);

  logger.info('Streaming to stdout, press CTRL+C to abort.');
  logger.info(
    'Use --json to output the stream as newline-delimited JSON without info logs.\n'
  );
  await streamToConsole(stream, streamId, opts);
};

/**
 * Listing streams only lists available stream IDs based on run/step passed,
 * and doesn't read any data from the streams.
 */
export const listStreamsByRunId = async (
  world: World,
  opts: InspectCLIOptions = {}
) => {
  if (opts.withData) {
    logger.warn('`withData` flag is ignored when listing streams');
  }
  if (opts.workflowName) {
    logger.warn(
      'Filtering by workflow-name is not supported for streams, ignoring filter.'
    );
  }
  if (opts.stepId) {
    logger.warn(
      'Filtering by step-id is not supported for streams, ignoring filter.'
    );
  }

  let runId = opts.runId;
  if (!runId) {
    logger.warn(
      'No run-id provided. Listing streams for latest run instead.',
      'Use --run=<run-id> to filter streams by run.'
    );
    const run = await getRecentRun(world, opts);
    if (!run) {
      logger.warn('No runs found.');
      return;
    }
    runId = run.runId;
  }

  try {
    const streamIds = await world.listStreamsByRunId(runId);
    const matchingStreams = streamIds.map((streamId) => ({
      runId,
      streamId,
    }));

    if (opts.json) {
      showJson(matchingStreams);
      return;
    }
    logger.log(showTable(matchingStreams, ['runId', 'streamId']));
  } catch (error) {
    if (handleApiError(error, opts.backend)) {
      process.exit(1);
    }
    throw error;
  }
};

export const listEvents = async (
  world: World,
  opts: InspectCLIOptions = {}
) => {
  if (opts.workflowName) {
    logger.warn(
      'Filtering by workflow-name is not supported for events, ignoring filter.'
    );
  }

  let filterId: string | undefined = opts.hookId || opts.stepId || opts.runId;
  if (!filterId) {
    filterId = (await getRecentRun(world, opts))?.runId;
    if (!filterId) {
      logger.error('No run found.');
      return;
    }
  }

  const isCorrelationId = Boolean(opts.hookId || opts.stepId);
  const params: Omit<ListEventsParams, 'runId'> = {
    pagination: {
      sortOrder: opts.sort || 'desc',
      cursor: opts.cursor,
      limit: opts.limit || DEFAULT_PAGE_SIZE,
    },
    resolveData: opts.withData ? 'all' : 'none',
  };
  const listCall = isCorrelationId
    ? (correlationId: string, pagination: PaginationOptions) =>
        world.events.listByCorrelationId({
          ...params,
          correlationId,
          pagination: { ...params.pagination, ...pagination },
        })
    : (runId: string, pagination: PaginationOptions) =>
        world.events.list({
          ...params,
          runId,
          pagination: { ...params.pagination, ...pagination },
        });

  // Determine which props to show based on withData flag
  const props = opts.withData
    ? EVENT_LISTED_PROPS
    : EVENT_LISTED_PROPS.filter((prop) => !EVENT_IO_PROPS.includes(prop));

  // For JSON output, just fetch once and return
  if (opts.json) {
    logger.debug(`Fetching events for run ${filterId}`);
    try {
      const events = await listCall(filterId, {});
      showJson(events.data);
      return;
    } catch (error) {
      if (handleApiError(error, opts.backend)) {
        process.exit(1);
      }
      throw error;
    }
  }

  await setupListPagination<Event>({
    initialCursor: opts.cursor,
    interactive: opts.interactive,
    fetchPage: async (cursor) => {
      logger.debug(`Fetching events for run ${filterId}`);
      try {
        const events = await listCall(filterId, { cursor });
        return {
          data: events.data,
          cursor: events.cursor,
          hasMore: events.hasMore,
        };
      } catch (error) {
        if (handleApiError(error, opts.backend)) {
          process.exit(1);
        }
        throw error;
      }
    },
    displayPage: async (events) => {
      logger.log(showTable(events, props, opts));
      showInspectInfoBox('event');
    },
  });
};

export const listHooks = async (world: World, opts: InspectCLIOptions = {}) => {
  if (opts.workflowName) {
    logger.warn(
      'Filtering by workflow-name is not supported for hooks, ignoring filter.'
    );
  }
  if (opts.stepId) {
    logger.warn(
      'Filtering by step-id is not supported for hooks, ignoring filter.'
    );
  }

  const runId = opts.runId;
  const resolveData = opts.withData ? 'all' : 'none';

  // For JSON output, just fetch once and return
  if (opts.json) {
    if (!runId) {
      logger.debug('Fetching all hooks');
    } else {
      logger.debug(`Fetching hooks for run ${runId}`);
    }
    try {
      const hooks = await world.hooks.list({
        runId,
        pagination: {
          sortOrder: opts.sort || 'desc',
          cursor: opts.cursor,
          limit: opts.limit || DEFAULT_PAGE_SIZE,
        },
        resolveData,
      });
      const hydratedHooks = hooks.data.map(hydrateResourceIO);
      showJson({ ...hooks, data: hydratedHooks });
      return;
    } catch (error) {
      if (handleApiError(error, opts.backend)) {
        process.exit(1);
      }
      throw error;
    }
  }

  // Setup pagination with new mechanism
  await setupListPagination<Hook>({
    initialCursor: opts.cursor,
    interactive: opts.interactive,
    fetchPage: async (cursor) => {
      if (!runId) {
        logger.debug('Fetching all hooks');
      } else {
        logger.debug(`Fetching hooks for run ${runId}`);
      }
      try {
        const hooks = await world.hooks.list({
          runId,
          pagination: {
            sortOrder: opts.sort || 'desc',
            cursor,
            limit: opts.limit || DEFAULT_PAGE_SIZE,
          },
          resolveData,
        });
        return {
          data: hooks.data,
          cursor: hooks.cursor,
          hasMore: hooks.hasMore,
        };
      } catch (error) {
        if (handleApiError(error, opts.backend)) {
          process.exit(1);
        }
        throw error;
      }
    },
    displayPage: async (hooks) => {
      const hydratedHooks = hooks.map(hydrateResourceIO);
      logger.log(showTable(hydratedHooks, HOOK_LISTED_PROPS, opts));
      showInspectInfoBox('hook');
    },
  });
};

export const showHook = async (
  world: World,
  hookId: string,
  opts: InspectCLIOptions = {}
) => {
  if (opts.withData) {
    logger.warn('`withData` flag is ignored when showing individual resources');
  }
  try {
    const hook = await world.hooks.get(hookId, {
      resolveData: 'all',
    });
    const hydratedHook = hydrateResourceIO(hook);
    if (opts.json) {
      showJson(hydratedHook);
      return;
    } else {
      logger.log(hydratedHook);
    }
  } catch (error) {
    if (handleApiError(error, opts.backend)) {
      process.exit(1);
    }
    throw error;
  }
};

export const listSleeps = async (
  world: World,
  opts: InspectCLIOptions = {}
) => {
  if (!opts.runId) {
    logger.error(
      'run-id is required for listing sleeps. Usage: `workflow inspect sleeps --runId=<id>`'
    );
    process.exit(1);
  }

  if (opts.stepId) {
    logger.warn(
      'Filtering by step-id is not supported for sleeps, ignoring filter.'
    );
  }
  if (opts.workflowName) {
    logger.warn(
      'Filtering by workflow-name is not supported for sleeps, ignoring filter.'
    );
  }
  if (opts.withData) {
    logger.warn('`withData` flag is ignored when listing sleeps');
  }

  try {
    // Fetch all events for the run with resolveData=false
    const events = await world.events.list({
      runId: opts.runId,
      pagination: {
        sortOrder: opts.sort || 'desc',
        limit: 1000,
      },
      resolveData: 'none',
    });

    // Show info message if there might be more sleeps
    if (events.hasMore) {
      logger.info(
        'Warning: This run has more than 1000 events. Some sleeps might not be shown. Please use the web UI to ensure getting a complete list.'
      );
    }

    // Filter locally by correlationId starting with 'wait_'
    const waitCorrelationIds = new Set<string>();
    for (const event of events.data) {
      if (event.correlationId?.startsWith('wait_')) {
        waitCorrelationIds.add(event.correlationId);
      }
    }

    if (waitCorrelationIds.size === 0) {
      logger.warn('No sleeps found for this run.');
      if (opts.json) {
        showJson([]);
      } else {
        logger.log(
          showTable([] as Record<string, unknown>[], WAIT_LISTED_PROPS, {
            ...opts,
            disableRelativeDates: true,
          })
        );
      }
      return;
    }

    // For each unique correlationId, fetch events by correlationId with resolveData=true
    const sleeps: Sleep[] = [];
    for (const correlationId of waitCorrelationIds) {
      const correlationEvents = await world.events.listByCorrelationId({
        correlationId,
        pagination: {
          sortOrder: 'asc',
          limit: 10,
        },
        resolveData: 'all',
      });

      // Stitch up wait_created and wait_completed events
      const waitCreated = correlationEvents.data.find(
        (e) => e.eventType === 'wait_created'
      );
      const waitCompleted = correlationEvents.data.find(
        (e) => e.eventType === 'wait_completed'
      );

      if (waitCreated) {
        const sleep: Sleep = {
          correlationId,
          runId: waitCreated.runId,
          eventId: waitCreated.eventId,
          createdAt: waitCreated.createdAt,
          resumeAt:
            waitCreated.eventType === 'wait_created'
              ? waitCreated.eventData.resumeAt
              : undefined,
          completedAt: waitCompleted?.createdAt,
        };
        sleeps.push(sleep);
      }
    }

    // Sort sleeps by createdAt
    sleeps.sort((a, b) => {
      const timeA = a.createdAt.getTime();
      const timeB = b.createdAt.getTime();
      return opts.sort === 'asc' ? timeA - timeB : timeB - timeA;
    });

    if (opts.json) {
      showJson(sleeps);
      return;
    }

    logger.log(
      showTable(
        sleeps as unknown as Record<string, unknown>[],
        WAIT_LISTED_PROPS,
        { ...opts, disableRelativeDates: true }
      )
    );
  } catch (error) {
    if (handleApiError(error, opts.backend)) {
      process.exit(1);
    }
    throw error;
  }
};
