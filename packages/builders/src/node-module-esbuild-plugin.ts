// @ts-nocheck

import { readFileSync } from 'node:fs';
import { normalize, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ERROR_SLUGS } from '@workflow/errors';
import builtinModules from 'builtin-modules';
import enhancedResolveOriginal from 'enhanced-resolve';
import type * as esbuild from 'esbuild';

const enhancedResolve = promisify(enhancedResolveOriginal);

// Match exact Node.js built-in module names:
// - "fs", "path", "stream" etc. (exact match)
// - "node:fs", "node:path" etc. (with node: prefix)
// But NOT "some-package/stream" or "eventsource-parser/stream"
const nodeModulesRegex = new RegExp(`^(${builtinModules.join('|')})$`);

type PackageViolation = {
  importer: string;
  path: string;
  packageName: string;
  packageRoot: string;
};

function getPackageName(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return null;

  const after = normalized.slice(idx + marker.length); // e.g. ".pnpm/node-fetch@3.3.2/node_modules/node-fetch/src/index.js"
  const segments = after.split('/');
  if (!segments.length) return null;

  let packageName = segments[0];

  // pnpm nests: ".pnpm/<pkg>@<version>/node_modules/<pkg>/..."
  if (packageName === '.pnpm' && segments.length >= 3) {
    packageName = segments[2];
    packageSegments = 3;
  } else if (packageName.startsWith('@') && segments.length >= 2) {
    packageName = `${segments[0]}/${segments[1]}`;
    packageSegments = 2;
  }

  return packageName;
}

export function createNodeModuleErrorPlugin(): esbuild.Plugin {
  return {
    name: 'workflow-node-module-error',
    setup(build) {
      const cwd = process.cwd();
      const importParents = new Map<string, string>();
      const packageViolations: PackageViolation[] = [];
      const seenPackages = new Set<string>();
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (!args.importer) return null;

        try {
          const resolvedChild = await enhancedResolve(
            args.resolveDir,
            args.path
          );
          // {
          //   resolvedChild: '/Users/adrianlam/GitHub/workflow/node_modules/.pnpm/node-fetch@3.3.2/node_modules/node-fetch/src/index.js',
          //   importer: '/Users/adrianlam/GitHub/workflow/workbench/sveltekit/workflows/user-signup.ts'
          // }

          if (resolvedChild) {
            importParents.set(
              normalize(resolvedChild),
              normalize(args.importer)
            );
          }
        } catch {
          // ignore
        }
        return null;
      });
      build.onResolve({ filter: nodeModulesRegex }, async (args) => {
        // console.log(relative(cwd, importParents.get(normalize(args.importer))));
        // console.log(args.path);
        const importerPath = resolve(cwd, args.importer);
        let current = importerPath;
        const chain: string[] = [];
        while (current) {
          chain.push(current);
          current = importParents.get(current);
        }
        const filteredChain = chain.filter(
          (path) => !path.includes('node_modules')
        );

        // Only track violations from the FIRST package level (direct dependencies)
        // Skip if this is a nested dependency (parent is also in node_modules)
        const parent = importParents.get(importerPath);
        const isDirectDependency = parent && !parent.includes('node_modules');

        if (isDirectDependency) {
          const packageName = getPackageName(importerPath);
          if (packageName && !seenPackages.has(packageName)) {
            seenPackages.add(packageName);
            packageViolations.push({
              path: args.path,
              importer: relative(cwd, filteredChain[0]),
              packageName,
            });
          }
        }

        console.log(packageViolations);

        return {
          path: args.path,
          external: true,
          // errors: [
          //   {
          //     text: `Cannot use Node.js module "${args.path}" in workflow functions. Move this module to a step function.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`,
          //   },
          // ],
        };
      });
      build.onEnd(() => {
        if (packageViolations.length > 0) {
          return {
            errors: packageViolations.map((violation) => ({
              text: `You are attempting to use a function from "${violation.packageName}" which is incompatible with workflow since it uses Node.js modules.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`,
              location: {
                file: violation.importer,
                line: 1,
                column: 18,
                suggestion: 'Move this module to a step function.',
                lineText: `import fetch from 'node-fetch';`,
                length: 12,
              },
            })),
          };
        }
      });
    },
  };
}
