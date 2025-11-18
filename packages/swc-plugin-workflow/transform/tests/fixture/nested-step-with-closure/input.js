import { DurableAgent } from '@workflow/ai/agent';
import { gateway } from 'ai';

export async function wflow() {
  'use workflow';
  let count = 42;

  async function namedStepWithClosureVars() {
    'use step';
    console.log('count', count);
  }

  const agent = new DurableAgent({
    arrowFunctionWithClosureVars: async () => {
      'use step';
      console.log('count', count);
      return gateway('openai/gpt-5');
    },

    namedFunctionWithClosureVars: async function() {
      'use step';
      console.log('count', count);
    },

    async methodWithClosureVars() {
      'use step';
      console.log('count', count);
    },
  });
}
