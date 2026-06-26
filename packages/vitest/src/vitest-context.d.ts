import 'vitest';
import type { ResolvedWorkflowTestOptions } from './options.js';

declare module 'vitest' {
  interface ProvidedContext {
    __workflowVitestOptions: ResolvedWorkflowTestOptions;
  }
}

export {};
