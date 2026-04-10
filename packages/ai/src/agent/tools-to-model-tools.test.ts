import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { toolsToModelTools } from './tools-to-model-tools.js';

describe('toolsToModelTools', () => {
  it('serializes function tools with description and inputSchema', async () => {
    const tools = {
      weather: tool({
        description: 'Get the weather',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Weather in ${city}: sunny`,
      }),
    };

    const result = await toolsToModelTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'function',
      name: 'weather',
      description: 'Get the weather',
    });
    expect(result[0]).toHaveProperty('inputSchema');
    expect(result[0]).not.toHaveProperty('id');
    expect(result[0]).not.toHaveProperty('args');
  });

  it('preserves provider tool type, id, and args', async () => {
    // Simulate a provider tool (e.g. anthropic.tools.webSearch)
    const providerTool = {
      type: 'provider' as const,
      id: 'anthropic.web_search' as const,
      args: { maxUses: 5 },
      inputSchema: { type: 'object' as const, properties: {} },
    };

    const tools = {
      webSearch: providerTool,
    } as any;

    const result = await toolsToModelTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'provider',
      id: 'anthropic.web_search',
      name: 'webSearch',
      args: { maxUses: 5 },
    });
  });

  it('handles mixed function and provider tools', async () => {
    const providerTool = {
      type: 'provider' as const,
      id: 'anthropic.web_search' as const,
      args: {},
      inputSchema: { type: 'object' as const, properties: {} },
    };

    const tools = {
      weather: tool({
        description: 'Get the weather',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Weather in ${city}: sunny`,
      }),
      webSearch: providerTool,
    } as any;

    const result = await toolsToModelTools(tools);

    expect(result).toHaveLength(2);

    const functionTool = result.find((t) => t.name === 'weather');
    const provider = result.find((t) => t.name === 'webSearch');

    expect(functionTool).toMatchObject({ type: 'function', name: 'weather' });
    expect(provider).toEqual({
      type: 'provider',
      id: 'anthropic.web_search',
      name: 'webSearch',
      args: {},
    });
  });

  it('defaults args to empty object when not provided on provider tool', async () => {
    const providerTool = {
      type: 'provider' as const,
      id: 'anthropic.code_execution' as const,
      inputSchema: { type: 'object' as const, properties: {} },
    };

    const tools = {
      codeExec: providerTool,
    } as any;

    const result = await toolsToModelTools(tools);

    expect(result[0]).toEqual({
      type: 'provider',
      id: 'anthropic.code_execution',
      name: 'codeExec',
      args: {},
    });
  });
});
