import { LocalBuilder } from './builders.js';

await new LocalBuilder({}).build();

export function workflowPlugin() {
  return {
    name: 'workflow-sveltekit-plugin',
    // async buildEnd() {
    //   if (process.env.VERCEL === '1') {
    //     await new VercelBuilder({}).build();
    //   }
    // },
  };
}

export { workflowRollupPlugin } from 'workflow/rollup-plugin';
