export { workflowPlugin as workflow } from './plugin.js';
export { workflowRoutes } from './routes.js';
import { LocalBuilder } from './builder.js';

const builder = new LocalBuilder();

// This needs to be in the top-level as we need to create these
// entries before react-router is started or the entries are
// a race to be created before react-router discovers entries via `workflowRoutes()`
await builder.build();
