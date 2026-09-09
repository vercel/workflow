import type { Hook, ListHooksParams } from './hooks.js';
import type { World } from './interfaces.js';
import type { QueuePayload } from './queue.js';
import type {
  ListWorkflowRunsParams,
  WorkflowRun,
  WorkflowRunWithoutData,
} from './runs.js';
import type { PaginatedResponse, PaginationOptions } from './shared.js';

export interface ObservabilityWorldSource {
  /** Stable user-facing source identifier, such as `vitest-0.sqlite`. */
  source: string;
  world: World;
}

interface SourceCursor {
  source: string;
  cursor?: string;
  exhausted?: true;
}

interface CompositeCursor {
  version: 1;
  sources: SourceCursor[];
}

interface Candidate<T> {
  sourceIndex: number;
  item: T;
  cursor: string | null;
  hasMore: boolean;
}

interface SettledMatches<T> {
  matches: { value: T; sourceIndex: number }[];
  firstError?: unknown;
  firstMissing?: unknown;
}

const CURSOR_PREFIX = 'sqlite-observability-v1:';

function encodeCursor(cursor: CompositeCursor): string {
  return `${CURSOR_PREFIX}${encodeURIComponent(JSON.stringify(cursor))}`;
}

function initialCursor(
  sources: readonly ObservabilityWorldSource[]
): CompositeCursor {
  return {
    version: 1,
    sources: sources.map(({ source }) => ({ source })),
  };
}

function parseCursor(
  value: string | undefined,
  sources: readonly ObservabilityWorldSource[]
): CompositeCursor {
  if (!value) return initialCursor(sources);
  try {
    if (!value.startsWith(CURSOR_PREFIX)) throw new Error('prefix');
    const parsed = JSON.parse(
      decodeURIComponent(value.slice(CURSOR_PREFIX.length))
    ) as CompositeCursor;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.sources) ||
      parsed.sources.length !== sources.length ||
      parsed.sources.some(
        (state, index) => state.source !== sources[index]?.source
      )
    ) {
      throw new Error('shape');
    }
    return parsed;
  } catch {
    throw new Error('Invalid SQLite observability cursor');
  }
}

function pageLimit(pagination: PaginationOptions | undefined): number {
  const limit = pagination?.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('pagination.limit must be between 1 and 1000');
  }
  return limit;
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const result = new Date(value).getTime();
    if (Number.isFinite(result)) return result;
  }
  return 0;
}

function compareItems<T extends Record<string, unknown>>(
  left: Candidate<T>,
  right: Candidate<T>,
  sortOrder: 'asc' | 'desc',
  idField: keyof T,
  sources: readonly ObservabilityWorldSource[]
): number {
  const direction = sortOrder === 'asc' ? 1 : -1;
  const byTime =
    (timestamp(left.item.createdAt) - timestamp(right.item.createdAt)) *
    direction;
  if (byTime !== 0) return byTime;
  const byId =
    String(left.item[idField]).localeCompare(String(right.item[idField])) *
    direction;
  if (byId !== 0) return byId;
  return (sources[left.sourceIndex]?.source ?? '').localeCompare(
    sources[right.sourceIndex]?.source ?? ''
  );
}

function sourceAt(
  sources: readonly ObservabilityWorldSource[],
  sourceIndex: number
): ObservabilityWorldSource {
  const source = sources[sourceIndex];
  if (!source) throw new Error('Invalid SQLite observability source index');
  return source;
}

async function fetchCandidate<T>(
  source: ObservabilityWorldSource,
  sourceIndex: number,
  sourceState: SourceCursor | undefined,
  sortOrder: 'asc' | 'desc',
  list: (
    source: ObservabilityWorldSource,
    pagination: PaginationOptions
  ) => Promise<PaginatedResponse<T>>
): Promise<Candidate<T> | undefined> {
  if (!sourceState) throw new Error('Invalid SQLite observability cursor');
  if (sourceState.exhausted) return undefined;
  const page = await list(source, {
    limit: 1,
    sortOrder,
    ...(sourceState.cursor ? { cursor: sourceState.cursor } : {}),
  });
  const item = page.data[0];
  if (!item) {
    sourceState.exhausted = true;
    return undefined;
  }
  return {
    sourceIndex,
    item,
    cursor: page.cursor,
    hasMore: page.hasMore,
  };
}

function advanceSourceCursor<T>(
  sourceState: SourceCursor,
  selected: Candidate<T>
): void {
  if (selected.hasMore && !selected.cursor) {
    throw new Error(
      `SQLite observability source ${JSON.stringify(sourceState.source)} returned hasMore without a cursor`
    );
  }
  if (selected.cursor) sourceState.cursor = selected.cursor;
  if (!selected.hasMore) sourceState.exhausted = true;
}

async function mergePages<T extends Record<string, unknown>>(
  sources: readonly ObservabilityWorldSource[],
  pagination: PaginationOptions | undefined,
  idField: keyof T,
  defaultSortOrder: 'asc' | 'desc',
  list: (
    source: ObservabilityWorldSource,
    pagination: PaginationOptions
  ) => Promise<PaginatedResponse<T>>,
  remember: (item: T, sourceIndex: number) => void | Promise<void>
): Promise<PaginatedResponse<T>> {
  const limit = pageLimit(pagination);
  const sortOrder = pagination?.sortOrder ?? defaultSortOrder;
  const state = parseCursor(pagination?.cursor, sources);
  const data: T[] = [];

  while (data.length < limit) {
    const candidates = (
      await Promise.all(
        sources.map((source, sourceIndex) =>
          fetchCandidate(
            source,
            sourceIndex,
            state.sources[sourceIndex],
            sortOrder,
            list
          )
        )
      )
    ).filter((candidate): candidate is Candidate<T> => candidate !== undefined);

    if (candidates.length === 0) break;
    candidates.sort((left, right) =>
      compareItems(left, right, sortOrder, idField, sources)
    );
    const selected = candidates[0];
    if (!selected) break;
    const selectedState = state.sources[selected.sourceIndex];
    if (!selectedState) throw new Error('Invalid SQLite observability cursor');
    advanceSourceCursor(selectedState, selected);
    await remember(selected.item, selected.sourceIndex);
    data.push(selected.item);
  }

  const hasMore = state.sources.some((source) => !source.exhausted);
  return {
    data,
    cursor: data.length > 0 ? encodeCursor(state) : null,
    hasMore,
  };
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function isNotFound(error: unknown): boolean {
  if (errorStatus(error) === 404) return true;
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' && name.includes('NotFound');
}

function collectSettledMatches<T>(
  attempts: readonly PromiseSettledResult<T>[]
): SettledMatches<T> {
  const matches: { value: T; sourceIndex: number }[] = [];
  let firstError: unknown;
  let firstMissing: unknown;
  for (const [sourceIndex, attempt] of attempts.entries()) {
    if (attempt.status === 'fulfilled') {
      matches.push({ value: attempt.value, sourceIndex });
    } else if (isNotFound(attempt.reason)) {
      firstMissing ??= attempt.reason;
    } else {
      firstError ??= attempt.reason;
    }
  }
  return { matches, firstError, firstMissing };
}

/**
 * Compose independently selected SQLite databases for read/inspection tools.
 * The databases remain separate Worlds; this adapter only merges reads and
 * routes run-scoped operations to the World that owns the run ID.
 */
// @lat: [[lat.md/rust-portability#Rust Portability Architecture#SQLite Local World#Vitest Database Selection]]
export function createAggregatedObservabilityWorld(
  inputSources: readonly ObservabilityWorldSource[]
): World {
  if (inputSources.length === 0) {
    throw new Error('SQLite observability requires at least one database');
  }
  const sources = [...inputSources];
  if (new Set(sources.map(({ source }) => source)).size !== sources.length) {
    throw new Error('SQLite observability source identifiers must be unique');
  }
  const firstSource = sources[0];
  if (!firstSource) {
    throw new Error('SQLite observability requires at least one database');
  }
  const specVersion = firstSource.world.specVersion;
  if (sources.some(({ world }) => world.specVersion !== specVersion)) {
    throw new Error('SQLite observability databases use incompatible specs');
  }

  const runSources = new Map<string, number>();

  function rememberRunId(runId: string, sourceIndex: number): void {
    const previous = runSources.get(runId);
    if (previous !== undefined && previous !== sourceIndex) {
      throw new Error(
        `Workflow run ${JSON.stringify(runId)} exists in multiple SQLite observability databases`
      );
    }
    runSources.set(runId, sourceIndex);
  }

  function rememberRun(
    run: WorkflowRun | WorkflowRunWithoutData,
    sourceIndex: number
  ): void {
    rememberRunId(run.runId, sourceIndex);
  }

  async function findSourceForRun(runId: string): Promise<number> {
    // Always probe every source. A list call may have cached one owner before
    // the same run ID reaches the head of another database's page; trusting
    // that cache would silently route later point reads to an ambiguous run.
    const attempts = await Promise.allSettled(
      sources.map(({ world }) => world.runs.get(runId, { resolveData: 'none' }))
    );
    const { matches, firstError, firstMissing } =
      collectSettledMatches(attempts);
    if (matches.length > 1) {
      throw new Error(
        `Workflow run ${JSON.stringify(runId)} exists in multiple SQLite observability databases`
      );
    }
    // A failed source cannot prove absence, so routing the one visible match
    // would weaken the duplicate-ID guard precisely when storage is unhealthy.
    if (firstError !== undefined) throw firstError;
    const match = matches[0];
    if (match) {
      rememberRunId(runId, match.sourceIndex);
      return match.sourceIndex;
    }
    throw firstMissing ?? new Error(`Workflow run ${runId} was not found`);
  }

  async function rememberUnambiguousRunId(
    runId: string,
    expectedSourceIndex: number
  ): Promise<void> {
    const sourceIndex = await findSourceForRun(runId);
    if (sourceIndex !== expectedSourceIndex) {
      throw new Error(
        `Workflow run ${JSON.stringify(runId)} changed SQLite observability databases while it was being listed`
      );
    }
  }

  async function findAcrossSources<T>(
    operation: (world: World) => Promise<T>,
    getRunId: (value: T) => string
  ): Promise<T> {
    const attempts = await Promise.allSettled(
      sources.map(({ world }) => operation(world))
    );
    const { matches, firstError, firstMissing } =
      collectSettledMatches(attempts);
    if (matches.length > 1) {
      throw new Error(
        'Resource exists in multiple SQLite observability databases'
      );
    }
    if (firstError !== undefined) throw firstError;
    const match = matches[0];
    if (match) {
      rememberRunId(getRunId(match.value), match.sourceIndex);
      return match.value;
    }
    throw firstMissing ?? new Error('Resource was not found');
  }

  const primary =
    sources.find(({ source }) => source === 'workflow.sqlite') ?? firstSource;

  const world = {
    specVersion,
    capabilities: {},
    runs: {
      async get(runId: string, params?: Parameters<World['runs']['get']>[1]) {
        const sourceIndex = await findSourceForRun(runId);
        const run = await sourceAt(sources, sourceIndex).world.runs.get(
          runId,
          params
        );
        rememberRun(run, sourceIndex);
        return run;
      },
      async waitForTerminalStatus(
        runId: string,
        params?: Parameters<
          NonNullable<World['runs']['waitForTerminalStatus']>
        >[1]
      ) {
        const sourceIndex = await findSourceForRun(runId);
        const sourceRuns = sourceAt(sources, sourceIndex).world.runs;
        const run = sourceRuns.waitForTerminalStatus
          ? await sourceRuns.waitForTerminalStatus(runId, params)
          : await sourceRuns.get(runId, params);
        rememberRun(run, sourceIndex);
        return run;
      },
      async list(params?: ListWorkflowRunsParams) {
        return mergePages<WorkflowRun | WorkflowRunWithoutData>(
          sources,
          params?.pagination,
          'runId',
          'desc',
          async ({ world: sourceWorld }, pagination) =>
            sourceWorld.runs.list({
              ...params,
              pagination,
            } as ListWorkflowRunsParams),
          (run, sourceIndex) => rememberUnambiguousRunId(run.runId, sourceIndex)
        );
      },
    },
    steps: {
      async get(
        runId: string,
        stepId: string,
        params?: Parameters<World['steps']['get']>[2]
      ) {
        const sourceIndex = await findSourceForRun(runId);
        return sourceAt(sources, sourceIndex).world.steps.get(
          runId,
          stepId,
          params
        );
      },
      async list(params: Parameters<World['steps']['list']>[0]) {
        const sourceIndex = await findSourceForRun(params.runId);
        return sourceAt(sources, sourceIndex).world.steps.list(params);
      },
    },
    events: {
      async create(
        runId: string | null,
        data: Parameters<World['events']['create']>[1],
        params?: Parameters<World['events']['create']>[2]
      ) {
        const sourceIndex =
          runId === null
            ? sources.indexOf(primary)
            : await findSourceForRun(runId);
        const result = await sourceAt(sources, sourceIndex).world.events.create(
          runId as string,
          data,
          params
        );
        if (result.run) rememberRun(result.run, sourceIndex);
        return result;
      },
      async get(
        runId: string,
        eventId: string,
        params?: Parameters<World['events']['get']>[2]
      ) {
        const sourceIndex = await findSourceForRun(runId);
        return sourceAt(sources, sourceIndex).world.events.get(
          runId,
          eventId,
          params
        );
      },
      async list(params: Parameters<World['events']['list']>[0]) {
        const sourceIndex = await findSourceForRun(params.runId);
        return sourceAt(sources, sourceIndex).world.events.list(params);
      },
      async listByCorrelationId(
        params: Parameters<World['events']['listByCorrelationId']>[0]
      ) {
        const sourceIndex = await findSourceForRun(params.runId);
        return sourceAt(sources, sourceIndex).world.events.listByCorrelationId(
          params
        );
      },
    },
    hooks: {
      async get(hookId: string, params?: Parameters<World['hooks']['get']>[1]) {
        return findAcrossSources(
          (sourceWorld) => sourceWorld.hooks.get(hookId, params),
          (hook) => hook.runId
        );
      },
      async getByToken(
        token: string,
        params?: Parameters<World['hooks']['getByToken']>[1]
      ) {
        return findAcrossSources(
          (sourceWorld) => sourceWorld.hooks.getByToken(token, params),
          (hook) => hook.runId
        );
      },
      async list(params: ListHooksParams) {
        if (params.runId) {
          const sourceIndex = await findSourceForRun(params.runId);
          return sourceAt(sources, sourceIndex).world.hooks.list(params);
        }
        return mergePages<Hook>(
          sources,
          params.pagination,
          'hookId',
          'desc',
          ({ world: sourceWorld }, pagination) =>
            sourceWorld.hooks.list({ ...params, pagination }),
          (hook, sourceIndex) =>
            rememberUnambiguousRunId(hook.runId, sourceIndex)
        );
      },
    },
    streams: {
      async write(runId: string, name: string, chunk: string | Uint8Array) {
        const sourceIndex = await findSourceForRun(runId);
        return sourceAt(sources, sourceIndex).world.streams.write(
          runId,
          name,
          chunk
        );
      },
      async writeMulti(
        runId: string,
        name: string,
        chunks: (string | Uint8Array)[]
      ) {
        const sourceIndex = await findSourceForRun(runId);
        const streams = sourceAt(sources, sourceIndex).world.streams;
        if (streams.writeMulti) return streams.writeMulti(runId, name, chunks);
        for (const chunk of chunks) await streams.write(runId, name, chunk);
      },
      async close(runId: string, name: string) {
        const sourceIndex = await findSourceForRun(runId);
        return sourceAt(sources, sourceIndex).world.streams.close(runId, name);
      },
      async get(runId: string, name: string, startIndex?: number) {
        const sourceIndex = await findSourceForRun(runId);
        return sourceAt(sources, sourceIndex).world.streams.get(
          runId,
          name,
          startIndex
        );
      },
      async list(runId: string) {
        const sourceIndex = await findSourceForRun(runId);
        return sourceAt(sources, sourceIndex).world.streams.list(runId);
      },
      async getChunks(
        runId: string,
        name: string,
        options?: Parameters<World['streams']['getChunks']>[2]
      ) {
        const sourceIndex = await findSourceForRun(runId);
        return sourceAt(sources, sourceIndex).world.streams.getChunks(
          runId,
          name,
          options
        );
      },
      async getInfo(runId: string, name: string) {
        const sourceIndex = await findSourceForRun(runId);
        return sourceAt(sources, sourceIndex).world.streams.getInfo(
          runId,
          name
        );
      },
    },
    async getDeploymentId() {
      return primary.world.getDeploymentId();
    },
    async queue(
      queueName: Parameters<World['queue']>[0],
      message: QueuePayload,
      options?: Parameters<World['queue']>[2]
    ) {
      const sourceIndex =
        typeof message.runId === 'string'
          ? await findSourceForRun(message.runId)
          : sources.indexOf(primary);
      return sourceAt(sources, sourceIndex).world.queue(
        queueName,
        message,
        options
      );
    },
    createQueueHandler(
      prefix: Parameters<World['createQueueHandler']>[0],
      handler: Parameters<World['createQueueHandler']>[1]
    ) {
      return primary.world.createQueueHandler(prefix, handler);
    },
    async start() {
      // Inspection never starts queue consumers or active-run recovery.
    },
    async close() {
      await Promise.all(
        sources.map(({ world: sourceWorld }) => sourceWorld.close?.())
      );
    },
    getEnvironment() {
      return primary.world.getEnvironment?.();
    },
    async getRuntimeDeadline() {
      return primary.world.getRuntimeDeadline?.();
    },
    async getEncryptionKeyForRun(
      runOrId: WorkflowRun | string,
      context?: Record<string, unknown>
    ) {
      const runId = typeof runOrId === 'string' ? runOrId : runOrId.runId;
      const sourceIndex = await findSourceForRun(runId);
      const operation = sourceAt(sources, sourceIndex).world
        .getEncryptionKeyForRun;
      if (!operation) return undefined;
      return typeof runOrId === 'string'
        ? operation(runOrId, context)
        : operation(runOrId);
    },
    async describeRun(run: Readonly<Record<string, unknown>>) {
      const runId = typeof run.runId === 'string' ? run.runId : undefined;
      if (!runId) return null;
      const sourceIndex = await findSourceForRun(runId);
      const source = sourceAt(sources, sourceIndex);
      try {
        const inner = await source.world.describeRun?.(run);
        return {
          ...(inner ?? {}),
          observabilitySource: source.source,
        };
      } catch {
        return { observabilitySource: source.source };
      }
    },
  };

  // The public World has overloads that preserve resolveData narrowing. Each
  // delegate forwards that option unchanged, but a single implementation
  // signature cannot express all overloads while building the object inline.
  return world as unknown as World;
}
