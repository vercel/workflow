// Runtime entry: this module must stay free of build-time dependencies
// (@workflow/builders, esbuild, SWC) so a NestJS app importing WorkflowModule
// can be bundled into a serverless function without dragging in the compiler.
// The builders are available via the `workflow/nest/builder` subpath.

export type { NestBuilderOptions } from './builder.js';
export type { NestVercelBuilderOptions } from './vercel-builder.js';
export {
  configureWorkflowController,
  WorkflowController,
} from './workflow.controller.js';
export {
  WorkflowModule,
  type WorkflowModuleOptions,
} from './workflow.module.js';
