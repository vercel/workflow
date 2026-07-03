import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSvelteKitFlowRouteCode,
  getSvelteKitStaticManifestDir,
  SvelteKitBuilder,
} from './builder.js';

describe('SvelteKit base path support', () => {
  it('passes normalized basePath to generated workflow routes', () => {
    const builder = new SvelteKitBuilder({
      workingDir: '/tmp/app',
      basePath: '/app/',
    }) as unknown as { config: { basePath: string } };

    expect(builder.config.basePath).toBe('/app');
  });

  it('copies public manifests into SvelteKit static root', () => {
    expect(getSvelteKitStaticManifestDir('/tmp/app')).toBe(
      join('/tmp/app', 'static/.well-known/workflow/v1')
    );
  });

  it('preserves health-capable method aliases when wrapping flow routes', () => {
    const routeCode =
      createSvelteKitFlowRouteCode(`import { workflowEntrypoint } from 'workflow/runtime';
const workflowCode = {};
export const POST = workflowEntrypoint(workflowCode, { basePath: "/app" });
export const GET = POST;
export const HEAD = POST;
export const OPTIONS = POST;`);

    expect(routeCode).toContain('export const GET = POST;');
    expect(routeCode).toContain('export const HEAD = POST;');
    expect(routeCode).toContain('export const OPTIONS = POST;');
    expect(routeCode).toContain('basePath: "/app"');
  });
});
