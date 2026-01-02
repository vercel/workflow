/**
 * Returns the singular or plural form of a word based on count.
 *
 * @param singular - The singular form of the word
 * @param plural - The plural form of the word
 * @param count - The count to determine which form to use
 * @returns The singular form if count is 1, otherwise the plural form
 *
 * @example
 * pluralize('step', 'steps', 1) // 'step'
 * pluralize('step', 'steps', 3) // 'steps'
 * pluralize('retry', 'retries', 0) // 'retries'
 */
export function pluralize(
  singular: string,
  plural: string,
  count: number
): string {
  return count === 1 ? singular : plural;
}
