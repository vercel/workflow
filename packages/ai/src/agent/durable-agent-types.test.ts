import { type InferUITools, tool, type UIMessage } from 'ai';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  DurableAgent,
  type InferDurableAgentTools,
  type InferDurableAgentUIMessage,
} from './durable-agent.js';

const getWeather = tool({
  description: 'Get weather for a location',
  inputSchema: z.object({ location: z.string() }),
  execute: async ({ location }) => `Weather in ${location}`,
});

type WeatherAgent = DurableAgent<{
  getWeather: typeof getWeather;
}>;

describe('InferDurableAgentTools', () => {
  it('infers the tools from a durable agent', () => {
    expectTypeOf<InferDurableAgentTools<WeatherAgent>>().toEqualTypeOf<{
      getWeather: typeof getWeather;
    }>();
  });
});

describe('DurableAgent tools', () => {
  it('exposes the configured tools on the agent instance', () => {
    const agent = new DurableAgent({
      model: 'test-model',
      tools: {
        getWeather,
      },
    });

    expectTypeOf(agent.tools).toEqualTypeOf<{
      getWeather: typeof getWeather;
    }>();
  });
});

describe('InferDurableAgentUIMessage', () => {
  it('infers the UI message type from a durable agent', () => {
    expectTypeOf<
      InferDurableAgentUIMessage<WeatherAgent, { threadId: string }>
    >().toEqualTypeOf<
      UIMessage<
        { threadId: string },
        never,
        InferUITools<InferDurableAgentTools<WeatherAgent>>
      >
    >();
  });
});
