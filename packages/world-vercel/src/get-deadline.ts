/**
 * Lazily loads `getDeadline` from `@vercel/functions` so importing
 * `@workflow/world-vercel` does not evaluate that package at module load.
 */

export async function getDeadline() {
  const { getDeadline } = await import('@vercel/functions');
  return getDeadline();
}
