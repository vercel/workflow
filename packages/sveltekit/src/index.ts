import { LocalBuilder } from './builders.js';

export function workflowBuilderPlugin() {
  return {
    name: 'workflow-sveltekit-plugin',
    async buildStart() {
      await new LocalBuilder({}).build();
    },
  };
}
