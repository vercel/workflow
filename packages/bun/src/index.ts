import type { Serve } from 'bun';
import { LocalBuilder } from './builders';
import { workflowPlugin } from './plugin';

// Build the workflows
await new LocalBuilder().build();

// Registers the plugin with Bun runtime
Bun.plugin(workflowPlugin());

export function createWorkflowRoutes(handlers: {
  flow: {
    POST: (
      req: Request,
      server: Serve.BaseServeOptions<any>
    ) => Response | Promise<Response>;
  };
  step: {
    POST: (
      req: Request,
      server: Serve.BaseServeOptions<any>
    ) => Response | Promise<Response>;
  };
  webhook: any; // Since webhook module exports various things
}): Serve.Routes<
  undefined,
  | '/.well-known/workflow/v1/flow'
  | '/.well-known/workflow/v1/step'
  | '/.well-known/workflow/v1/webhook/:token'
> {
  return {
    '/.well-known/workflow/v1/flow': handlers.flow,
    '/.well-known/workflow/v1/step': handlers.step,
    '/.well-known/workflow/v1/webhook/:token': handlers.webhook,
  };
}
