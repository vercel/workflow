// Runtime entry: this module must stay free of build-time dependencies
// (@workflow/builders, esbuild, SWC) so a NestJS app importing WorkflowModule
// can be bundled into a serverless function without dragging in the compiler.
// The builders are available via the `workflow/nest/builder` subpath.

export type { NestBuilderOptions } from './builder.js';
export {
  WORKFLOW_MODULE_OPTIONS,
  WORKFLOW_OPTIONS,
  type WorkflowModuleAsyncOptions,
  type WorkflowModuleOptions,
} from './options.js';
export type { NestVercelBuilderOptions } from './vercel-builder.js';
export {
  configureWorkflowController,
  WorkflowController,
} from './workflow.controller.js';
export { WorkflowModule } from './workflow.module.js';
