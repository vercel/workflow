import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import type { PaginatedResponse } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';

const ulid = monotonicFactory(() => Math.random());

/**
 * Truncate a possibly-untrusted value for inclusion in an error message.
 * Keeps error output actionable for developers in dev mode while limiting
 * the amount of attacker-controlled data reflected back if a `world-local`
 * backend is ever run in a context that surfaces these messages to clients.
 */
function truncateForError(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value);
  const MAX = 48;
  return s.length > MAX ? `${s.slice(0, MAX)}…` : s;
}

/**
 * Thrown when a caller-supplied entity ID contains characters that would
 * escape the storage root (path traversal) or otherwise produce an unsafe
 * filename. Extends {@link WorkflowWorldError} so the platform's standard
 * error-to-HTTP mapping handles it alongside other world-layer errors.
 */
export class UnsafeEntityIdError extends WorkflowWorldError {
  constructor(kind: string, value: string) {
    super(
      `Unsafe ${kind} "${truncateForError(value)}": must not be empty, start with ".", or contain path separators or null bytes`
    );
    this.name = 'UnsafeEntityIdError';
  }

  static is(value: unknown): value is UnsafeEntityIdError {
    return value instanceof Error && value.name === 'UnsafeEntityIdError';
  }
}

/**
 * Validate that a string is safe to embed in a filesystem path as a single
 * path component. Rejects values that are:
 *   - empty
 *   - starting with `.` (blocks `.`, `..`, `.locks`, `.tmp`, and other
 *     hidden or reserved filenames)
 *   - containing `/`, `\`, or a NUL byte
 *
 * This is the primary defense against path-traversal attacks where a
 * request body supplies a `runId` / `stepId` / `correlationId` containing
 * `../` sequences to read or write files outside the storage root.
 * {@link resolveWithinBase} provides a belt-and-suspenders containment
 * check at the point of `path.join` for defense in depth.
 *
 * @param kind - Human-readable label used in the error message (e.g. "runId")
 * @param value - The value to validate; throws {@link UnsafeEntityIdError}
 *   if the value is not safe.
 */
export function assertSafeEntityId(kind: string, value: string): void {
  if (
    value.length === 0 ||
    value.startsWith('.') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new UnsafeEntityIdError(kind, value);
  }
}

/**
 * Join `basedir` with an entity-relative path and assert the result stays
 * inside `basedir`. Complements {@link assertSafeEntityId}: per-entry-point
 * validation is the primary defense, and this final check catches any path
 * escape that slipped past (e.g. a new call site that forgot to validate,
 * or an unusual character combination on a future filesystem). Throws
 * {@link UnsafeEntityIdError} if the joined path escapes `basedir`.
 */
export function resolveWithinBase(
  basedir: string,
  ...segments: string[]
): string {
  const resolvedBase = path.resolve(basedir);
  const joined = path.resolve(basedir, ...segments);
  if (joined !== resolvedBase && !joined.startsWith(resolvedBase + path.sep)) {
    throw new UnsafeEntityIdError('path', segments.join('/'));
  }
  return joined;
}

const isWindows = process.platform === 'win32';

/**
 * Execute a filesystem operation with retry logic on Windows.
 * On Windows, file operations can fail with EPERM/EBUSY/EACCES when files
 * are briefly locked by another process or antivirus. This wrapper adds
 * exponential backoff retry logic. On non-Windows platforms, executes directly.
 */
async function withWindowsRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  if (!isWindows) return fn();

  const retryableErrors = ['EPERM', 'EBUSY', 'EACCES'];
  const baseDelayMs = 10;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRetryable =
        attempt < maxRetries && retryableErrors.includes(error.code);
      if (!isRetryable) throw error;
      // Exponential backoff with jitter
      const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // TypeScript: unreachable, but satisfies return type
  throw new Error('Retry loop exited unexpectedly');
}

// In-memory cache of created files to avoid expensive fs.access() calls
// This is safe because we only write once per file path (no overwrites without explicit flag)
const createdFilesCache = new Set<string>();

/**
 * Clear the created files cache. Useful for testing or when files are deleted externally.
 */
export function clearCreatedFilesCache(): void {
  createdFilesCache.clear();
}

export { ulidToDate } from '@workflow/world';

/**
 * Regex matching a tag suffix on a fileId (after `.json` has been stripped).
 * E.g., `wrun_ABC.vitest-0` → the `.vitest-0` part.
 * Tags start with a letter and contain alphanumeric chars and hyphens.
 * Entity IDs (ULIDs, step_N, etc.) never contain dots, so the first dot
 * always marks the tag boundary.
 */
const TAG_PATTERN = /\.[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * Strip a tag suffix from a fileId.
 * `wrun_ABC.vitest-0` → `wrun_ABC`
 * `wrun_ABC` → `wrun_ABC` (no-op if no tag)
 */
export function stripTag(fileId: string): string {
  return fileId.replace(TAG_PATTERN, '');
}

/**
 * Build the file path for an entity, with optional tag embedded in the filename.
 * `taggedPath('/data', 'runs', 'wrun_ABC', 'vitest-0')` → `/data/runs/wrun_ABC.vitest-0.json`
 * `taggedPath('/data', 'runs', 'wrun_ABC')` → `/data/runs/wrun_ABC.json`
 *
 * The `fileId` and `tag` are validated with {@link assertSafeEntityId} and
 * the result is containment-checked with {@link resolveWithinBase} to
 * prevent path-traversal attacks when values are derived from untrusted
 * request input.
 */
export function taggedPath(
  basedir: string,
  entityDir: string,
  fileId: string,
  tag?: string
): string {
  assertSafeEntityId('fileId', fileId);
  if (tag !== undefined) assertSafeEntityId('tag', tag);
  const filename = tag ? `${fileId}.${tag}.json` : `${fileId}.json`;
  return resolveWithinBase(basedir, entityDir, filename);
}

/**
 * Read a JSON entity with tagged fallback.
 * When a tag is set, tries the tagged path first, then falls back to the
 * untagged path (so a tagged world can read entities written without a tag).
 */
export async function readJSONWithFallback<T>(
  basedir: string,
  entityDir: string,
  fileId: string,
  schema: z.ZodType<T>,
  tag?: string
): Promise<T | null> {
  assertSafeEntityId('fileId', fileId);
  if (tag !== undefined) assertSafeEntityId('tag', tag);
  if (tag) {
    const result = await readJSON(
      resolveWithinBase(basedir, entityDir, `${fileId}.${tag}.json`),
      schema
    );
    if (result !== null) return result;
  }
  return readJSON(
    resolveWithinBase(basedir, entityDir, `${fileId}.json`),
    schema
  );
}

/**
 * List all filenames in a directory that have a specific tag.
 * Returns full filenames (e.g., `wrun_ABC.vitest-0.json`).
 */
export async function listTaggedFiles(
  dirPath: string,
  tag: string
): Promise<string[]> {
  const suffix = `.${tag}.json`;
  try {
    const files = await fs.readdir(dirPath);
    return files.filter((f) => f.endsWith(suffix));
  } catch (error) {
    if ((error as any).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * List all filenames in a directory that have a specific tag and extension.
 * Returns full filenames (e.g., `stream-chnk_ABC.vitest-0.bin`).
 */
export async function listTaggedFilesByExtension(
  dirPath: string,
  tag: string,
  extension: string
): Promise<string[]> {
  const suffix = `.${tag}${extension}`;
  try {
    const files = await fs.readdir(dirPath);
    return files.filter((f) => f.endsWith(suffix));
  } catch (error) {
    if ((error as any).code === 'ENOENT') return [];
    throw error;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (_error) {
    // Ignore if already exists
  }
}

interface WriteOptions {
  overwrite?: boolean;
}

/**
 * Custom JSON replacer that encodes Uint8Array as base64 strings.
 * Format: { __type: 'Uint8Array', data: '<base64>' }
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __type: 'Uint8Array',
      data: Buffer.from(value).toString('base64'),
    };
  }
  return value;
}

/**
 * Custom JSON reviver that decodes base64 strings back to Uint8Array.
 */
export function jsonReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as any).__type === 'Uint8Array' &&
    typeof (value as any).data === 'string'
  ) {
    return new Uint8Array(Buffer.from((value as any).data, 'base64'));
  }
  return value;
}

export async function writeJSON(
  filePath: string,
  data: any,
  opts?: WriteOptions
): Promise<void> {
  return write(filePath, JSON.stringify(data, jsonReplacer, 2), opts);
}

/**
 * Writes data to a file using atomic write-rename pattern.
 *
 * Note: While this function uses temp files to avoid partial writes,
 * it does not provide protection against concurrent writes from multiple
 * processes. In a multi-writer scenario, the last writer wins.
 * For production use with multiple writers, consider using a proper
 * database or locking mechanism.
 */
export async function write(
  filePath: string,
  data: string | Buffer,
  opts?: WriteOptions
): Promise<void> {
  if (!opts?.overwrite) {
    // Fast path: check in-memory cache first to avoid expensive fs.access() calls
    // This provides significant performance improvement when creating many files
    if (createdFilesCache.has(filePath)) {
      throw new EntityConflictError(
        `File ${filePath} already exists and 'overwrite' is false`
      );
    }

    // Slow path: check filesystem for files created before this process started
    try {
      await fs.access(filePath);
      // File exists on disk, add to cache for future checks
      createdFilesCache.add(filePath);
      throw new EntityConflictError(
        `File ${filePath} already exists and 'overwrite' is false`
      );
    } catch (error: any) {
      // If file doesn't exist (ENOENT), continue with write
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const tempPath = `${filePath}.tmp.${ulid()}`;
  let tempFileCreated = false;
  try {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(tempPath, data);
    tempFileCreated = true;
    await withWindowsRetry(() => fs.rename(tempPath, filePath));
    // Track this file in cache so future writes know it exists
    createdFilesCache.add(filePath);
  } catch (error) {
    // Only try to clean up temp file if it was actually created
    if (tempFileCreated) {
      await withWindowsRetry(() => fs.unlink(tempPath), 3).catch(() => {});
    }
    throw error;
  }
}

export async function readJSON<T>(
  filePath: string,
  decoder: z.ZodType<T>
): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return decoder.parse(JSON.parse(content, jsonReviver));
  } catch (error) {
    if ((error as any).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readBuffer(filePath: string): Promise<Buffer> {
  const content = await fs.readFile(filePath);
  return content;
}

export async function deleteJSON(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as any).code !== 'ENOENT') throw error;
  }
}

/**
 * Atomically create a file using O_CREAT | O_EXCL flags.
 * Returns true if the file was created, false if it already exists.
 * This is atomic at the OS level, safe for concurrent access.
 */
export async function writeExclusive(
  filePath: string,
  data: string
): Promise<boolean> {
  await ensureDir(path.dirname(filePath));
  try {
    await fs.writeFile(filePath, data, { flag: 'wx' });
    return true;
  } catch (error: any) {
    if (error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

export async function listJSONFiles(dirPath: string): Promise<string[]> {
  return listFilesByExtension(dirPath, '.json');
}

export async function listFilesByExtension(
  dirPath: string,
  extension: string
): Promise<string[]> {
  try {
    const files = await fs.readdir(dirPath);
    return files
      .filter((f) => f.endsWith(extension))
      .map((f) => f.slice(0, -extension.length));
  } catch (error) {
    if ((error as any).code === 'ENOENT') return [];
    throw error;
  }
}

interface PaginatedFileSystemQueryConfig<T> {
  directory: string;
  schema: z.ZodType<T>;
  filePrefix?: string;
  filter?: (item: T) => boolean;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  getCreatedAt(filename: string): Date | null;
  getId?(item: T): string;
}
// Cursor format: "timestamp|id" for tie-breaking
interface ParsedCursor {
  timestamp: Date;
  id: string | null;
}

function parseCursor(cursor: string | undefined): ParsedCursor | null {
  if (!cursor) return null;

  const parts = cursor.split('|');
  return {
    timestamp: new Date(parts[0]),
    id: parts[1] || null,
  };
}

function createCursor(timestamp: Date, id: string | undefined): string {
  return id ? `${timestamp.toISOString()}|${id}` : timestamp.toISOString();
}

export async function paginatedFileSystemQuery<T extends { createdAt: Date }>(
  config: PaginatedFileSystemQueryConfig<T>
): Promise<PaginatedResponse<T>> {
  const {
    directory,
    schema,
    filePrefix,
    filter,
    sortOrder = 'desc',
    limit = 20,
    cursor,
    getCreatedAt,
    getId,
  } = config;

  // Validate filePrefix (typically `${runId}-`) so request-derived prefixes
  // consistently reject unsafe characters. filePrefix is only used below to
  // filter readdir() results by prefix — it doesn't participate in path
  // construction — but keeping the validation rule uniform across the
  // storage layer avoids special cases and catches bad values earlier.
  if (filePrefix !== undefined) {
    assertSafeEntityId('filePrefix', filePrefix);
  }

  // 1. Get all JSON files in directory
  const fileIds = await listJSONFiles(directory);

  // 2. Filter by prefix if provided
  const relevantFileIds = filePrefix
    ? fileIds.filter((fileId) => fileId.startsWith(filePrefix))
    : fileIds;

  // 3. ULID Optimization: Filter by cursor using filename timestamps before loading JSON
  const parsedCursor = parseCursor(cursor);
  let candidateFileIds = relevantFileIds;

  if (parsedCursor) {
    candidateFileIds = relevantFileIds.filter((fileId) => {
      const filenameDate = getCreatedAt(`${fileId}.json`);
      if (filenameDate) {
        // Use filename timestamp for cursor filtering
        // We need to be careful here: if parsedCursor has an ID (for tie-breaking),
        // we need to include items with the same timestamp for later ID-based filtering.
        // If no ID, we can use strict inequality for optimization.
        const cursorTime = parsedCursor.timestamp.getTime();
        const fileTime = filenameDate.getTime();

        if (parsedCursor.id) {
          // Tie-breaking mode: include items at or near cursor timestamp
          return sortOrder === 'desc'
            ? fileTime <= cursorTime
            : fileTime >= cursorTime;
        } else {
          // No tie-breaking: strict inequality
          return sortOrder === 'desc'
            ? fileTime < cursorTime
            : fileTime > cursorTime;
        }
      }
      // Can't extract timestamp from filename (e.g., steps use sequential IDs).
      // Include the file and defer to JSON-based filtering below.
      return true;
    });
  }

  // 4. Load files individually and collect valid items
  const validItems: T[] = [];

  for (const fileId of candidateFileIds) {
    const filePath = path.join(directory, `${fileId}.json`);
    let item: T | null = null;
    try {
      item = await readJSON(filePath, schema);
    } catch (error: unknown) {
      // We don't expect zod errors to happen, but if the JSON does get malformed,
      // we skip the item. Preferably, we'd have a way to mark items as malformed,
      // so that the UI can display them as such, with richer messaging. In the meantime,
      // we just log a warning and skip the item.
      if (error instanceof z.ZodError) {
        console.warn(
          `Skipping item ${fileId} due to malformed JSON: ${error.message}`
        );
        continue;
      }
      throw error;
    }

    if (item) {
      // Apply custom filter early if provided
      if (filter && !filter(item)) continue;

      // Double-check cursor filtering with actual createdAt from JSON
      // (in case ULID timestamp differs from stored createdAt)
      if (parsedCursor) {
        const itemTime = item.createdAt.getTime();
        const cursorTime = parsedCursor.timestamp.getTime();

        if (sortOrder === 'desc') {
          // For descending order, skip items >= cursor
          if (itemTime > cursorTime) continue;
          // If timestamps are equal, use ID for tie-breaking (skip if ID >= cursorId)
          if (itemTime === cursorTime && parsedCursor.id && getId) {
            const itemId = getId(item);
            if (itemId >= parsedCursor.id) continue;
          }
        } else {
          // For ascending order, skip items <= cursor
          if (itemTime < cursorTime) continue;
          // If timestamps are equal, use ID for tie-breaking (skip if ID <= cursorId)
          if (itemTime === cursorTime && parsedCursor.id && getId) {
            const itemId = getId(item);
            if (itemId <= parsedCursor.id) continue;
          }
        }
      }

      validItems.push(item);
    }
  }

  // 5. Sort by createdAt (and by ID for tie-breaking if getId is provided)
  validItems.sort((a, b) => {
    const aTime = a.createdAt.getTime();
    const bTime = b.createdAt.getTime();
    const timeComparison = sortOrder === 'asc' ? aTime - bTime : bTime - aTime;

    // If timestamps are equal and we have getId, use ID for stable sorting
    if (timeComparison === 0 && getId) {
      const aId = getId(a);
      const bId = getId(b);
      return sortOrder === 'asc'
        ? aId.localeCompare(bId)
        : bId.localeCompare(aId);
    }

    return timeComparison;
  });

  // 6. Apply pagination
  const hasMore = validItems.length > limit;
  const items = hasMore ? validItems.slice(0, limit) : validItems;
  const nextCursor =
    items.length > 0
      ? createCursor(
          items[items.length - 1].createdAt,
          getId?.(items[items.length - 1])
        )
      : null;

  return {
    data: items,
    cursor: nextCursor,
    hasMore,
  };
}
