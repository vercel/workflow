// import { LocalBuilder } from "./builder.js";

// const builder = new LocalBuilder();

// // This needs to be in the top-level as we need to create these
// // entries before astro plugin is started or the entries are
// // a race to be created before astro discovers entries
// await builder.build();

export { workflowPlugin } from './plugin.js';
