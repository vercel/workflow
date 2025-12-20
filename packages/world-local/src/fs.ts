import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WorkflowAPIError } from '@workflow/errors';
import type { PaginatedResponse } from '@workflow/world';
import { decodeTime, monotonicFactory } from 'ulid';
import { z } from 'zod';

const ulid = monotonicFactory(() => Math.random());

const Ulid = z.string().ulid();

// In-memory cache of created files to avoid expensive fs.access() calls
// This is safe because we only write once per file path (no overwrites without explicit flag)
const createdFilesCache = new Set<string>();

/**
 * Clear the created files cache. Useful for testing or when files are deleted externally.
 */
export function clearCreatedFilesCache(): void {
  createdFilesCache.clear();
}

export function ulidToDate(maybeUlid: string): Date | null {
  const ulid = Ulid.safeParse(maybeUlid);
  if (!ulid.success) {
    return null;
  }

  return new Date(decodeTime(ulid.data));
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

export async function writeJSON(
  filePath: string,
  data: any,
  opts?: WriteOptions
): Promise<void> {
  return write(filePath, JSON.stringify(data, null, 2), opts);
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
      throw new WorkflowAPIError(
        `File ${filePath} already exists and 'overwrite' is false`,
        { status: 409 }
      );
    }

    // Slow path: check filesystem for files created before this process started
    try {
      await fs.access(filePath);
      // File exists on disk, add to cache for future checks
      createdFilesCache.add(filePath);
      throw new WorkflowAPIError(
        `File ${filePath} already exists and 'overwrite' is false`,
        { status: 409 }
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
    await fs.rename(tempPath, filePath);
    // Track this file in cache so future writes know it exists
    createdFilesCache.add(filePath);
  } catch (error) {
    // Only try to clean up temp file if it was actually created
    if (tempFileCreated) {
      await fs.unlink(tempPath).catch(() => {});
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
    return decoder.parse(JSON.parse(content));
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

export async function listJSONFiles(dirPath: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dirPath);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));
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
