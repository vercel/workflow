/**
 * Parse --module flag from CLI args.
 * Returns null when the value is invalid.
 */
export function parseModuleType(args: string[]): 'es6' | 'commonjs' | null {
  const idx = args.indexOf('--module');
  if (idx === -1 || idx + 1 >= args.length) return 'es6';
  const value = args[idx + 1];
  if (value === 'commonjs') return 'commonjs';
  if (value === 'es6') return 'es6';
  return null;
}
