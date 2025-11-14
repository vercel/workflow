import { AstroBuilder } from './builder.js';

const builder = new AstroBuilder();

// This needs to be in the top-level as we need to create these
// entries before svelte plugin is started or the entries are
// a race to be created before svelte discovers entries
await builder.build();

export { workflowPlugin } from './plugin.js';
