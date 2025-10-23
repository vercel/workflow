import { type ClassValue, clsx } from 'clsx';
import { formatDistanceStrict } from 'date-fns';
import { twMerge } from 'tailwind-merge';

export const DEFAULT_PAGE_SIZE = 10;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const LIVE_UPDATE_INTERVAL_MS = 5000;

/**
 * Returns a formatted pagination display string
 * @param currentPage - The current page number
 * @param totalPages - The total number of pages visited so far
 * @param hasMore - Whether there are more pages available
 * @returns Formatted string like "Page 1 of 3+" or "Page 2 of 2"
 */
export function getPaginationDisplay(
  currentPage: number,
  totalPages: number,
  hasMore: boolean
): string {
  if (hasMore) {
    return `Page ${currentPage} of ${totalPages}+`;
  }
  return `Page ${currentPage} of ${totalPages}`;
}

export const formatDuration = (
  start: number | string | Date | undefined,
  end: number | string | Date | undefined
): string | null => {
  if (!start || !end) return null;
  return formatDistanceStrict(new Date(start), new Date(end));
};
