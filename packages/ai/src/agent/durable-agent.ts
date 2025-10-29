import type {
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from '@ai-sdk/provider';
import {
  asSchema,
  type ModelMessage,
  type ToolSet,
  type UIMessageChunk,
} from 'ai';
import { convertToLanguageModelPrompt, standardizePrompt } from 'ai/internal';
import { getWritable } from 'workflow';
import { streamTextIterator } from './stream-text-iterator.js';

/**
 * Configuration options for creating a {@link DurableAgent} instance.
 */
export interface DurableAgentOptions {
  /**
   * The model identifier to use for the agent.
   * This should be a string compatible with the AI SDK (e.g., 'anthropic/claude-opus').
   */
  model: string;

  /**
   * A set of tools available to the agent.
   * Tools can be implemented as workflow steps for automatic retries and persistence,
   * or as regular workflow-level logic using core library features like sleep() and Hooks.
   */
  tools: ToolSet;

  /**
   * Optional system prompt to guide the agent's behavior.
   */
  system?: string;
}

/**
 * Options for the {@link DurableAgent.stream} method.
 */
export interface DurableAgentStreamOptions {
  /**
   * The conversation messages to process. Should follow the AI SDK's ModelMessage format.
   */
  messages: ModelMessage[];

  /**
   * Optional system prompt override. If provided, overrides the system prompt from the constructor.
   */
  system?: string;

  /**
   * Optional custom writable stream for handling message chunks. If not provided, a default writable stream will be created using getWritable().
   */
  writable?: WritableStream<UIMessageChunk>;
}

/**
 * A class for building durable AI agents within workflows.
 *
 * DurableAgent enables you to create AI-powered agents that can maintain state
 * across workflow steps, call tools, and gracefully handle interruptions and resumptions.
 * It integrates seamlessly with the AI SDK and the Workflow DevKit for
 * production-grade reliability.
 *
 * @example
 * ```typescript
 * const agent = new DurableAgent({
 *   model: 'anthropic/claude-opus',
 *   tools: {
 *     getWeather: {
 *       description: 'Get weather for a location',
 *       inputSchema: z.object({ location: z.string() }),
 *       execute: getWeatherStep,
 *     },
 *   },
 *   system: 'You are a helpful weather assistant.',
 * });
 *
 * await agent.stream({
 *   messages: [{ role: 'user', content: 'What is the weather?' }],
 * });
 * ```
 */
export class DurableAgent {
  private model: string;
  private tools: ToolSet;
  private system?: string;

  constructor(options: DurableAgentOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.system = options.system;
  }

  generate() {
    throw new Error('Not implemented');
  }

  async stream(options: DurableAgentStreamOptions) {
    const prompt = await standardizePrompt({
      system: options.system || this.system,
      messages: options.messages,
    });

    const modelPrompt = await convertToLanguageModelPrompt({
      prompt,
      supportedUrls: {},
      download: undefined,
    });

    const writable = options.writable || getWritable();

    const iterator = streamTextIterator({
      // TODO: Figure out serialization on the `model` instance.
      // For now we'll just support the string -> AI Gateway interface.
      model: this.model,
      tools: this.tools,
      writable,
      prompt: modelPrompt,
    });

    let result = await iterator.next();
    while (!result.done) {
      const toolCalls = result.value;
      const toolResults = await Promise.all(
        toolCalls.map(
          (toolCall): Promise<LanguageModelV2ToolResultPart> =>
            executeTool(toolCall, this.tools)
        )
      );
      result = await iterator.next(toolResults);
    }

    await closeStream(writable);
  }
}

async function closeStream(writable: WritableStream<UIMessageChunk>) {
  'use step';

  await writable.close();
}

async function executeTool(
  toolCall: LanguageModelV2ToolCall,
  tools: ToolSet
): Promise<LanguageModelV2ToolResultPart> {
  const tool = tools[toolCall.toolName];
  if (!tool) throw new Error(`Tool "${toolCall.toolName}" not found`);
  if (typeof tool.execute !== 'function')
    throw new Error(
      `Tool "${toolCall.toolName}" does not have an execute function`
    );
  const schema = asSchema(tool.inputSchema);
  const input = await schema.validate?.(JSON.parse(toolCall.input || '{}'));
  if (!input?.success) {
    throw new Error(
      `Invalid input for tool "${toolCall.toolName}": ${input?.error?.message}`
    );
  }
  const toolResult = await tool.execute(input.value, {
    toolCallId: toolCall.toolCallId,
    // TODO: pass the proper messages to the tool
    messages: [],
  });

  return {
    type: 'tool-result',
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    output: {
      type: 'text',
      value: JSON.stringify(toolResult) ?? '',
    },
  };
}
