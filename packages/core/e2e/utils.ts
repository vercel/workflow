import { spawn } from 'node:child_process';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getWorkbenchAppPath(overrideAppName?: string): string {
  const appName = process.env.APP_NAME ?? overrideAppName;
  if (!appName) {
    throw new Error('`APP_NAME` environment variable is not set');
  }
  return path.join(__dirname, '../../../workbench', appName);
}

export function isLocalDeployment(): boolean {
  const deploymentUrl = process.env.DEPLOYMENT_URL;
  if (!deploymentUrl) return false;

  const localHosts = ['localhost', '127.0.0.1'];
  return localHosts.some((host) => deploymentUrl.includes(host));
}

/**
 * Checks if the current test is running against a vite-based framework.
 * Vite-based frameworks: vite, sveltekit, astro
 */
export function isViteBasedFramework(): boolean {
  const appName = process.env.APP_NAME as string;
  // TODO: figure out how to get sourcemaps working in these frameworks too
  return ['vite', 'sveltekit', 'astro'].includes(appName);
}

/**
 * Checks if step error source maps are expected to work in the current test environment.
 * Source maps work in:
 * - Vercel prod deployments (production builds have proper source maps)
 * - Local dev mode (DEV_TEST_CONFIG is set, uses step bundle with inline source maps)
 *
 * Source maps do NOT work in:
 * - Local prod builds (nitro/bundler output doesn't preserve source maps)
 */
export function hasStepSourceMaps(): boolean {
  // Next.js and SvelteKit currently do not consume inline sourcemaps from the step bundle
  // TODO: we need to fix this in Next.js and/or SvelteKit
  const appName = process.env.APP_NAME as string;
  if (['nextjs-webpack', 'nextjs-turbopack', 'sveltekit'].includes(appName)) {
    return false;
  }

  if (!isLocalDeployment()) {
    // Vercel deployments have proper source maps
    return true;
  }
  // Local dev mode has source maps (DEV_TEST_CONFIG is only set for dev tests)
  if (process.env.DEV_TEST_CONFIG) {
    return true;
  }

  // Prod buils for frameowrks off-vercel typically don't consume source maps
  return false;
}

/**
 * Checks if workflow error source maps are expected to work in the current test environment.
 * Source maps work in most environments EXCEPT:
 * - Vite-based frameworks (vite, sveltekit, astro) in local deployments
 *   These frameworks have a known issue where helpers.ts references are not preserved
 */
export function hasWorkflowSourceMaps(): boolean {
  const appName = process.env.APP_NAME as string;

  // Vercel deployments have proper source map support for workflow error
  if (!isLocalDeployment()) {
    return true;
  }

  // These frameworks currently don't handle sourcemaps correctly in local dev
  // TODO: figure out how to get sourcemaps working in these frameworks too
  if (['vite', 'sveltekit', 'astro'].includes(appName)) {
    return false;
  }

  // Works everywhere else
  return true;
}

function getCliArgs(): string {
  const deploymentUrl = process.env.DEPLOYMENT_URL;
  if (!deploymentUrl) {
    throw new Error('`DEPLOYMENT_URL` environment variable is not set');
  }

  if (isLocalDeployment()) {
    return '';
  }

  return `--backend vercel --verbose`;
}

const awaitCommand = async (command: string, args: string[], cwd: string) => {
  console.log(`[Debug]: Executing ${command} ${args.join(' ')}`);
  console.log(`[Debug]: in CWD: ${cwd}`);
  return await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        shell: true,
        timeout: 5_000,
        cwd,
        env: {
          ...process.env,
          DEBUG: '1',
        },
      } as any);

      let stdout = '';
      let stderr = '';

      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          const text = Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk);
          process.stdout.write(chunk);
          stdout += text;
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const text = Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk);
          process.stderr.write(chunk);
          stderr += text;
        });
      }

      child.on('error', (err) => reject(err));
      child.on('close', () => {
        resolve({ stdout, stderr });
      });
    }
  );
};

/**
 * Returns headers needed to bypass Vercel Deployment Protection.
 * When VERCEL_AUTOMATION_BYPASS_SECRET is set, includes the x-vercel-protection-bypass header.
 */
export function getProtectionBypassHeaders(): HeadersInit {
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    return {
      'x-vercel-protection-bypass': bypassSecret,
    };
  }
  return {};
}

export const cliInspectJson = async (args: string) => {
  const cliAppPath = getWorkbenchAppPath();
  const cliArgs = getCliArgs();

  const command = `node ./node_modules/workflow/bin/run.js inspect`;
  const result = await awaitCommand(
    command,
    ['--json', args, cliArgs],
    cliAppPath
  );
  try {
    console.log('Result:', result.stdout);
    const json = JSON.parse(result.stdout || '{}');
    return { json, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    console.error('Stdout:', result.stdout);
    console.error('Stderr:', result.stderr);
    err.message = `Error parsing JSON result from CLI: ${err.message}`;
    throw err;
  }
};
