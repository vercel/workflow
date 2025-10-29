import { LocalBuilder } from './builders.js';

export function workflowBuilderPlugin() {
  return {
    name: 'workflow-sveltekit-plugin',
    async configResolved() {
      await new LocalBuilder({}).build();
    },
  };
}
