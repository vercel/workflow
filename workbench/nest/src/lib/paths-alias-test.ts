/**
 * This is a utility function from outside the workbench app directory.
 * It is used to test that esbuild can resolve tsconfig path aliases.
 * Note: This is NOT a step function - it's a regular function that gets called
 * from within a step to verify path alias imports work correctly.
 */
export function pathsAliasHelper(): string {
  return 'pathsAliasHelper';
}
