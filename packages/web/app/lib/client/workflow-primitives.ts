import type { PaginatedResult } from '~/lib/types';
import type { WorkflowWebAPIError } from './workflow-errors';

export const MAX_ITEMS = 1000;

/**
 * Merges two arrays by a unique ID key, with later items overriding earlier ones.
 */
export function mergeById<T>(prev: T[], next: T[], idKey: string): T[] {
  const combined = [...prev, ...next];
  const uniqueById = new Map(
    combined.map((item) => [(item as any)[idKey], item])
  );
  return Array.from(uniqueById.values());
}

/**
 * Exhaustively fetches all pages of a paginated resource.
 */
export async function fetchAllPaginated<T>(
  fetchPage: (
    cursor?: string
  ) => Promise<
    | { error: WorkflowWebAPIError; result: null }
    | { error: null; result: PaginatedResult<T> }
  >
): Promise<{ data: T[]; cursor?: string }> {
  let allData: T[] = [];
  let currentCursor: string | undefined;
  while (true) {
    const { error, result } = await fetchPage(currentCursor);
    // TODO: We're not handling errors well for infinite fetches
    if (error) break;
    allData = [...allData, ...result.data];
    if (!result.hasMore || !result.cursor || allData.length >= MAX_ITEMS) break;
    currentCursor = result.cursor;
  }
  return { data: allData, cursor: currentCursor };
}

/**
 * Polls a paginated resource for new items, merging them into existing state.
 * Returns true if new items were found.
 *
 * @param cursorStrategy - 'always': advance cursor whenever one is returned.
 *   'onHasMore': only advance when hasMore is true (re-fetches existing items to catch status updates).
 * @param transform - Optional transform applied to each new item before merging (e.g. hydrateResourceIO).
 */
export async function pollResource<T>(opts: {
  fetchFn: () => Promise<
    | { error: WorkflowWebAPIError; result: null }
    | { error: null; result: PaginatedResult<T> }
  >;
  setItems: (updater: (prev: T[]) => T[]) => void;
  setCursor: (cursor: string | undefined) => void;
  setError: (error: Error | null) => void;
  idKey: string;
  cursorStrategy?: 'always' | 'onHasMore';
  transform?: (item: T) => T;
}): Promise<boolean> {
  const {
    fetchFn,
    setItems,
    setCursor,
    setError,
    idKey,
    cursorStrategy = 'always',
    transform,
  } = opts;

  const { error, result } = await fetchFn();
  if (error) {
    setError(error);
    return false;
  }

  if (result.data.length > 0) {
    const newData = transform ? result.data.map(transform) : result.data;
    setItems((prev) => mergeById(prev, newData, idKey));
    const shouldAdvanceCursor =
      cursorStrategy === 'onHasMore'
        ? !!(result.cursor && result.hasMore)
        : !!result.cursor;
    if (shouldAdvanceCursor) {
      setCursor(result.cursor);
    }
    return true;
  }
  return false;
}
