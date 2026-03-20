import { createHash } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import { stripTag, ulidToDate } from '../fs.js';

/**
 * Hash a hook token to produce a filesystem-safe constraint filename.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Create a monotonic ULID factory that ensures ULIDs are always increasing
 * even when generated within the same millisecond.
 */
export const monotonicUlid = monotonicFactory(() => Math.random());

/**
 * Creates a function to extract createdAt date from a filename based on ULID.
 * Used for efficient pagination without reading file contents.
 *
 * @param idPrefix - The prefix to strip from filenames (e.g., 'wrun', 'evnt', 'step')
 * @returns A function that extracts Date from filename, or null if not extractable
 */
export const getObjectCreatedAt =
  (idPrefix: string) =>
  (filename: string): Date | null => {
    // Strip tag suffix before ULID extraction
    // e.g., "wrun_ABC.vitest-0.json" → "wrun_ABC.json"
    const cleanName = stripTag(filename.replace(/\.json$/, '')) + '.json';

    const replaceRegex = new RegExp(`^${idPrefix}_`, 'g');
    const dashIndex = cleanName.indexOf('-');

    if (dashIndex === -1) {
      // No dash - extract ULID from the filename (e.g., wrun_ULID.json, evnt_ULID.json)
      const ulid = cleanName.replace(/\.json$/, '').replace(replaceRegex, '');
      return ulidToDate(ulid);
    }

    // For composite keys like {runId}-{stepId}, extract from the appropriate part
    if (idPrefix === 'step') {
      // Steps use sequential IDs (step_0, step_1, etc.) - no timestamp in filename.
      // Return null to skip filename-based optimization and defer to JSON-based filtering.
      return null;
    }

    // For events: wrun_ULID-evnt_ULID.json - extract from the eventId part
    const id = cleanName.substring(dashIndex + 1).replace(/\.json$/, '');
    const ulid = id.replace(replaceRegex, '');
    return ulidToDate(ulid);
  };
