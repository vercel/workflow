/**
 * This is a test step function from outside the workbench app directory.
 * It is used to test that the swc-esbuild-plugin can resolve tsconfig path aliases.
 */
export async function pathsAliasTest() {
  'use step';
  return 'pathsAliasTest';
}
