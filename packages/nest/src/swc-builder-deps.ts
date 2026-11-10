import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'pathe';

/**
 * Packages the NestJS CLI's SWC builder (`compilerOptions.builder: "swc"`)
 * loads from the application. They are optional peers of `@workflow/nest`, so
 * package managers do not install them; the application has to list them.
 */
export const SWC_BUILDER_PACKAGES = ['@swc/cli', '@swc/core'] as const;

function isInstalled(pkg: string, workingDir: string): boolean {
  // Yarn PnP has no node_modules to walk.
  if (process.versions.pnp) {
    try {
      createRequire(join(workingDir, 'package.json')).resolve(pkg);
      return true;
    } catch {
      return false;
    }
  }
  // Walk node_modules directly instead of `require.resolve`, which also
  // searches NODE_PATH and can find a copy the application does not have.
  let dir = resolve(workingDir);
  while (true) {
    if (existsSync(join(dir, 'node_modules', pkg, 'package.json'))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Return the SWC builder packages that are not installed for `workingDir`.
 */
export function findMissingSwcBuilderPackages(workingDir: string): string[] {
  return SWC_BUILDER_PACKAGES.filter((pkg) => !isInstalled(pkg, workingDir));
}
