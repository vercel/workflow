import { LocalBuilder } from './builders.js';

export function workflowPlugin() {
  return {
    name: 'workflow-sveltekit-plugin',
    async configResolved() {
      await new LocalBuilder({}).build();
    },
    // async buildEnd() {
    //   if (process.env.VERCEL === '1') {
    //     await new VercelBuilder({}).build();
    //   }
    // },
  };
}

export { workflowRollupPlugin } from 'workflow/rollup-plugin';
