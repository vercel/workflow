/** JavaScript and TypeScript source extensions understood by workflow builds. */
export const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

export const SOURCE_FILE_GLOB = `**/*.{${SOURCE_EXTENSIONS.map((extension) => extension.slice(1)).join(',')}}`;

export const SOURCE_FILE_REGEX = new RegExp(
  `(?:${SOURCE_EXTENSIONS.map((extension) => `\\${extension}`).join('|')})$`
);

export function isWorkflowSourceFile(file: string): boolean {
  return SOURCE_FILE_REGEX.test(file);
}

/**
 * Source candidates for explicit JavaScript output extensions. Exact files
 * win; TypeScript/JSX source substitutions are attempted only when absent.
 */
export const SOURCE_EXTENSION_ALIASES: Record<string, string[]> = {
  '.js': ['.js', '.ts', '.tsx', '.jsx'],
  '.jsx': ['.jsx', '.tsx'],
  '.mjs': ['.mjs', '.mts'],
  '.cjs': ['.cjs', '.cts'],
};

export function getSourceExtensionFallbacks(extension: string): string[] {
  return SOURCE_EXTENSION_ALIASES[extension]?.slice(1) ?? [];
}
