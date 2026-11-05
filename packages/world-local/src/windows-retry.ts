// Dependency-free on purpose: fence-lock.ts imports it, and its cross-process
// tests fork a child that loads fence-lock.ts's import graph for every
// acquisition-killing iteration. Importing `fs.ts` here would pull in
// `@workflow/world` and its schemas.

const isWindows = process.platform === 'win32';

/**
 * Execute a filesystem operation with retry logic on Windows.
 * On Windows, file operations can fail with EPERM/EBUSY/EACCES when files
 * are briefly locked by another process or antivirus. This wrapper adds
 * exponential backoff retry logic. On non-Windows platforms, executes directly.
 */
export async function withWindowsRetry<T>(
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
