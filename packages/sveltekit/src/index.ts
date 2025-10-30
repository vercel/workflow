import { LocalBuilder, VercelBuilder } from './builders.js';

export function workflowPlugin() {
  return {
    name: 'workflow-sveltekit-plugin',
    async configResolved() {
      if (process.env.VERCEL === '1') {
        await new VercelBuilder({}).build();
      } else {
        await new LocalBuilder({}).build();
      }
    },
  };
}

export { workflowRollupPlugin } from 'workflow/rollup-plugin';
