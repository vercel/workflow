/**
 * Strftime Formatting Functions
 *
 * Handles date/time formatting for printf's %(...)T directive.
 */
/**
 * Format a timestamp using strftime-like format string.
 */
export declare function formatStrftime(format: string, timestamp: number, tz?: string): string;
