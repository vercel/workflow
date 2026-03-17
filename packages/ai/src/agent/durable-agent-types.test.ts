import { type InferUITools, tool, type UIMessage } from 'ai';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type {
  DurableAgent,
  InferDurableAgentTools,
  InferDurableAgentUIMessage,
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
