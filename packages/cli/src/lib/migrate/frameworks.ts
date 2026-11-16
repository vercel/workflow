import type { MigrationFramework } from './framework.js';
import { inngestFramework } from './inngest/index.js';

/** Frameworks `workflow migrate <from>` can migrate from, by `from`. */
// biome-ignore lint/suspicious/noExplicitAny: each framework has its own context type
export const FRAMEWORKS: Record<string, MigrationFramework<any>> = {
  [inngestFramework.id]: inngestFramework,
};
