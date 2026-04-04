import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from 'ai';
import { toolsToModelTools } from './tools-to-model-tools.js';

describe('toolsToModelTools', () => {
  it('converts a basic function tool', async () => {
    const tools = {
      weather: tool({
        description: 'Get weather',
        inputSchema: z.object({ location: z.string() }),
        execute: async () => 'sunny',
      }),
    };

    const result = await toolsToModelTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'function',
      name: 'weather',
      description: 'Get weather',
    });
    expect(result[0]).toHaveProperty('inputSchema');
    expect(result[0]).not.toHaveProperty('strict');
    expect(result[0]).not.toHaveProperty('inputExamples');
  });

  it('forwards strict: true', async () => {
    const tools = {
      weather: tool({
        description: 'Get weather',
        inputSchema: z.object({ location: z.string() }),
        execute: async () => 'sunny',
        strict: true,
      }),
    };

    const result = await toolsToModelTools(tools);

    expect(result[0]).toMatchObject({ strict: true });
  });

  it('forwards strict: false', async () => {
    const tools = {
      weather: tool({
        description: 'Get weather',
        inputSchema: z.object({ location: z.string() }),
        execute: async () => 'sunny',
        strict: false,
      }),
    };

    const result = await toolsToModelTools(tools);

    expect(result[0]).toMatchObject({ strict: false });
  });

  it('omits strict key when not set', async () => {
    const tools = {
      weather: tool({
        description: 'Get weather',
        inputSchema: z.object({ location: z.string() }),
        execute: async () => 'sunny',
      }),
    };

    const result = await toolsToModelTools(tools);

    expect(result[0]).not.toHaveProperty('strict');
  });

  it('forwards inputExamples', async () => {
    const examples = [{ input: { location: 'Tokyo' } }];
    const tools = {
      weather: tool({
        description: 'Get weather',
        inputSchema: z.object({ location: z.string() }),
        execute: async () => 'sunny',
        inputExamples: examples,
      }),
    };

    const result = await toolsToModelTools(tools);

    expect(result[0]).toMatchObject({ inputExamples: examples });
  });

  it('omits inputExamples key when not set', async () => {
    const tools = {
      weather: tool({
        description: 'Get weather',
        inputSchema: z.object({ location: z.string() }),
        execute: async () => 'sunny',
      }),
    };

    const result = await toolsToModelTools(tools);

    expect(result[0]).not.toHaveProperty('inputExamples');
  });

  it('forwards providerOptions', async () => {
    const providerOptions = { openai: { parallel_tool_calls: false } };
    const tools = {
      weather: tool({
        description: 'Get weather',
        inputSchema: z.object({ location: z.string() }),
        execute: async () => 'sunny',
        providerOptions,
      }),
    };

    const result = await toolsToModelTools(tools);

    expect(result[0]).toMatchObject({ providerOptions });
  });

  it('handles provider-type tools', async () => {
    const tools = {
      webSearch: {
        type: 'provider' as const,
        id: 'openai.web_search' as const,
        args: { search_context_size: 'medium' },
      },
    };

    const result = await toolsToModelTools(
      tools as any // provider tools don't have inputSchema/execute
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'provider',
      name: 'webSearch',
      id: 'openai.web_search',
      args: { search_context_size: 'medium' },
    });
  });

  it('handles a mix of function and provider tools', async () => {
    const tools = {
      weather: tool({
        description: 'Get weather',
        inputSchema: z.object({ location: z.string() }),
        execute: async () => 'sunny',
      }),
      webSearch: {
        type: 'provider' as const,
        id: 'openai.web_search' as const,
        args: {},
      },
    };

    const result = await toolsToModelTools(tools as any);

    expect(result).toHaveLength(2);
    expect(result.find((t) => t.name === 'weather')?.type).toBe('function');
    expect(result.find((t) => t.name === 'webSearch')?.type).toBe('provider');
  });

  it('handles tools with type: "dynamic" as function tools', async () => {
    const tools = {
      dynamic: {
        type: 'dynamic' as const,
        description: 'A dynamic tool',
        inputSchema: z.object({ input: z.string() }),
        execute: async () => 'result',
      },
    };

    const result = await toolsToModelTools(tools as any);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'function',
      name: 'dynamic',
      description: 'A dynamic tool',
    });
  });

  it('returns empty array for empty tools', async () => {
    const result = await toolsToModelTools({});
    expect(result).toEqual([]);
  });
});
