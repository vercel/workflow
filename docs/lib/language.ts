export const LANGUAGE_QUERY_PARAM = 'language';

export function resolveLanguage(
  languages: readonly string[],
  requested?: string | null
): string {
  return requested && languages.includes(requested)
    ? requested
    : (languages[0] ?? 'ts');
}
