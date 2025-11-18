import { DurableAgent } from '@workflow/ai/agent';
import { gateway, tool } from 'ai';
import * as z from 'zod';

export async function test() {
  'use workflow';

  const agent = new DurableAgent({
    model: async () => {
      'use step';
      return gateway('openai/gpt-5');
    },
    tools: {
      getWeather: tool({
        description: 'Get weather for a location',
        inputSchema: z.object({ location: z.string() }),
        execute: async ({ location }) => {
          'use step';
          return `Weather in ${location}: Sunny, 72°F`;
        },
      }),
    },
  });

  await agent.stream({
    messages: [
      { role: 'user', content: 'What is the weather in San Francisco?' },
    ],
  });
}

