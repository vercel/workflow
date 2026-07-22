import {
  execFile as execFileOriginal,
  exec as execOriginal,
} from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, test } from 'vitest';
import { getWorkbenchAppPath } from './utils';

const exec = promisify(execOriginal);
const execFile = promisify(execFileOriginal);

/**
 * Regression test for the o2flow v5 upgrade incident (workflow@5.0.0-beta.26,
 * fixed by #2752 in 5.0.0-beta.28).
 *
 * # The bug
 *
 * A plain Next.js API route — no workflow directives anywhere in its module
 * graph — imported a hook from a shared module and resumed it:
 *
 * ```ts
 * // workflows/hooks.ts (no directives)
 * export const sandboxDoneHook = defineHook<SandboxDoneEvent>();
 *
 * // app/api/internal/sandbox-complete/route.ts
 * await sandboxDoneHook.resume(token, payload);
 * ```
 *
 * `defineHook` comes from the root `workflow` entry, which at the time did
 * NOT carry the `@workflow/core/runtime/world-init` side-effect import (only
 * `workflow/api` did). Turbopack tree-shook `world.ts` — and its module-load
 * `globalThis[GetWorldFnKey] ??= getWorld` registration — out of the route
 * bundle. `getWorldLazy()` then fell through to its last-resort
 * `await import(['./world', 'js'].join('.'))`, which Turbopack compiles into
 * a stub that throws:
 *
 *     Cannot find module as expression is too dynamic
 *
 * so every `hook.resume()` from that route failed and workflow runs hung on
 * their hooks forever.
 *
 * # Why nothing caught it before production
 *
 * The failure only manifests when the route bundle is loaded in ISOLATION,
 * like a Vercel lambda (where next.config.js is serialized at build time and
 * never evaluated at runtime). Under local `next dev` / `next start`, loading
 * `next.config.ts` evaluates the `workflow/next` module chain in the same
 * process, which registers the world on `globalThis` and masks the bug. The
 * e2e suites all drive a long-lived server process, so they were masked too.
 *
 * # What this test does
 *
 * 1. Builds the nextjs-turbopack workbench with a production Turbopack build
 *    (the local world target — the world choice is irrelevant to the bug).
 * 2. Loads ONLY the compiled route bundle for `/api/resume-plain-hook` in a
 *    bare Node.js subprocess — simulating a cold Vercel lambda — and invokes
 *    its POST handler with a token that doesn't exist.
 * 3. Expects the well-formed `Hook not found` failure, proving the route
 *    resolved the workflow world from inside an isolated bundle. On broken
 *    versions this instead reports the Turbopack dynamic-require stub error.
 */
describe('route bundle isolation (o2flow hook.resume regression)', () => {
  test(
    'defineHook().resume() resolves the world inside an isolated route bundle',
    { timeout: 300_000 },
    async () => {
      const appPath = getWorkbenchAppPath('nextjs-turbopack');

      // Strip Vercel env so the build deterministically injects the local
      // world target regardless of where this test runs.
      const buildEnv = { ...process.env, FORCE_COLOR: '0' };
      delete buildEnv.VERCEL;
      delete buildEnv.VERCEL_ENV;
      delete buildEnv.VERCEL_DEPLOYMENT_ID;
      delete buildEnv.VERCEL_PROJECT_ID;

      await exec('pnpm build', { cwd: appPath, env: buildEnv });

      const routeBundlePath = path.join(
        appPath,
        '.next/server/app/api/resume-plain-hook/route.js'
      );

      // Load the route bundle and call its handler in a fresh subprocess so
      // nothing else (dev server, next.config evaluation, other routes) can
      // register the workflow world on globalThis first. This mirrors how a
      // Vercel lambda cold-starts an isolated route function.
      //
      // The harness prefixes its single result line with a unique marker so
      // the test can find it even when the route bundle or the world logs to
      // stdout before or after it.
      const RESULT_MARKER = '__ROUTE_BUNDLE_ISOLATION_RESULT__';
      const harness = `
        const m = require(process.argv[1]);
        const report = (result) =>
          console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(result));
        // module.exports may resolve asynchronously (Turbopack async modules)
        Promise.resolve(m)
          .then(async (mod) => {
            const POST = mod.routeModule?.userland?.POST;
            if (typeof POST !== 'function') {
              report({
                harnessError: 'route bundle did not expose routeModule.userland.POST',
                exportKeys: Object.keys(mod),
              });
              return;
            }
            const res = await POST(
              new Request('http://localhost/api/resume-plain-hook', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  token: 'route-bundle-isolation-nonexistent-token',
                  ok: true,
                }),
              })
            );
            report({ status: res.status, body: await res.text() });
          })
          .catch((err) => {
            report({
              harnessError: err instanceof Error ? err.message : String(err),
            });
          });
      `;

      const { stdout } = await execFile(
        process.execPath,
        ['-e', harness, routeBundlePath],
        { cwd: appPath, env: buildEnv, timeout: 60_000 }
      );

      const resultLine = stdout
        .split('\n')
        .filter((line) => line.includes(RESULT_MARKER))
        .at(-1);
      if (!resultLine) {
        throw new Error(
          `route bundle harness produced no ${RESULT_MARKER} line; full stdout:\n${stdout}`
        );
      }
      const result = JSON.parse(
        resultLine.slice(
          resultLine.indexOf(RESULT_MARKER) + RESULT_MARKER.length
        )
      ) as {
        status?: number;
        body?: string;
        harnessError?: string;
        exportKeys?: string[];
      };

      expect(
        result.harnessError,
        `harness failed: ${resultLine}\nfull stdout:\n${stdout}`
      ).toBeUndefined();

      // The exact failure from the o2flow incident: Turbopack replaced the
      // world-resolution fallback with a dynamic-require stub because the
      // world registration was tree-shaken out of the route bundle.
      expect(result.body).not.toContain(
        'Cannot find module as expression is too dynamic'
      );
      // The fixed code's loud failure for the same class of bug (world-init
      // side effect missing from the bundle). Seeing this means the
      // registration chain from the root `workflow` entry broke again.
      expect(result.body).not.toContain('world runtime was not initialized');

      // The healthy outcome for a token that doesn't exist: the world
      // resolved inside the isolated bundle and the lookup failed cleanly.
      expect(result.status).toBe(500);
      expect(result.body).toContain('Hook not found');
    }
  );
});
