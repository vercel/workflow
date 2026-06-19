import { describe, expect, it } from 'vitest';
import {
  resolveDeferredWorkflowRouteStubSource,
  shouldNotifySocketForDiscoveredPattern,
} from './loader.js';

describe('workflow loader discovery notifications', () => {
  it('notifies for unchanged files that still contain workflow patterns', () => {
    expect(
      shouldNotifySocketForDiscoveredPattern(false, {
        hasWorkflow: true,
        hasStep: false,
        hasSerde: false,
      })
    ).toBe(true);
    expect(
      shouldNotifySocketForDiscoveredPattern(false, {
        hasWorkflow: false,
        hasStep: true,
        hasSerde: false,
      })
    ).toBe(true);
    expect(
      shouldNotifySocketForDiscoveredPattern(false, {
        hasWorkflow: false,
        hasStep: false,
        hasSerde: true,
      })
    ).toBe(true);
  });

  it('only notifies for plain files when pattern state changed', () => {
    const plainPatternState = {
      hasWorkflow: false,
      hasStep: false,
      hasSerde: false,
    };

    expect(
      shouldNotifySocketForDiscoveredPattern(false, plainPatternState)
    ).toBe(false);
    expect(
      shouldNotifySocketForDiscoveredPattern(true, plainPatternState)
    ).toBe(true);
  });
});

describe('deferred workflow route stubs', () => {
  it('returns the generated route after the deferred build completes', async () => {
    await expect(
      resolveDeferredWorkflowRouteStubSource({
        filename: '/app/.well-known/workflow/v1/flow/route.js',
        sourceMap: 'source-map',
        waitForDeferredBuild: async () => {},
        readGeneratedRoute: async () => 'export async function POST() {}',
      })
    ).resolves.toEqual({
      code: 'export async function POST() {}',
      map: 'source-map',
    });
  });

  it('throws instead of returning stub output when the deferred build fails', async () => {
    const cause = new Error('Timed out waiting for deferred route build');

    await expect(
      resolveDeferredWorkflowRouteStubSource({
        filename: '/app/.well-known/workflow/v1/flow/route.js',
        sourceMap: undefined,
        waitForDeferredBuild: async () => {
          throw cause;
        },
        readGeneratedRoute: async () =>
          '// WORKFLOW_ROUTE_STUB_FILE\nexport const __workflowRouteStub = true;',
      })
    ).rejects.toThrow('Refusing to compile the route stub');
  });

  it('throws when the deferred build leaves the generated route as a stub', async () => {
    let thrownError: unknown;

    try {
      await resolveDeferredWorkflowRouteStubSource({
        filename: '/app/.well-known/workflow/v1/flow/route.js',
        sourceMap: undefined,
        waitForDeferredBuild: async () => {},
        readGeneratedRoute: async () =>
          '// WORKFLOW_ROUTE_STUB_FILE\nexport const __workflowRouteStub = true;',
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toContain(
      'Refusing to compile the route stub'
    );
    expect((thrownError as { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((thrownError as { cause?: Error }).cause as Error).message).toBe(
      'Deferred route build completed, but the generated route file is still the workflow route stub.'
    );
  });
});
