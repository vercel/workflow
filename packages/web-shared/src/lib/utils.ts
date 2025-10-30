import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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
