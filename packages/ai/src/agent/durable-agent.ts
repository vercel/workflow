import type {
  LanguageModelV2,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from '@ai-sdk/provider';
import {
  asSchema,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type UIMessageChunk,
} from 'ai';
import { convertToLanguageModelPrompt, standardizePrompt } from 'ai/internal';
import { FatalError } from 'workflow';
import { streamTextIterator } from './stream-text-iterator.js';

/**
 * Configuration options for creating a {@link DurableAgent} instance.
 */
export interface DurableAgentOptions {
  /**
   * The model provider to use for the agent.
   *
   * This should be a string compatible with the Vercel AI Gateway (e.g., 'anthropic/claude-opus'),
   * or a step function that returns a `LanguageModelV2` instance.
   */
  model: string | (() => Promise<LanguageModelV2>);

  /**
   * A set of tools available to the agent.
   * Tools can be implemented as workflow steps for automatic retries and persistence,
   * or as regular workflow-level logic using core library features like sleep() and Hooks.
   */
  tools?: ToolSet;

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
   * The stream to which the agent writes message chunks. For example, use `getWritable<UIMessageChunk>()` to write to the workflow's default output stream.
   */
  writable: WritableStream<UIMessageChunk>;

  /**
   * If true, prevents the writable stream from being closed after streaming completes.
   * Defaults to false (stream will be closed).
   */
  preventClose?: boolean;

  /**
   * If true, sends a 'start' chunk at the beginning of the stream.
   * Defaults to true.
   */
  sendStart?: boolean;

  /**
   * If true, sends a 'finish' chunk at the end of the stream.
   * Defaults to true.
   */
  sendFinish?: boolean;

  /**
   * Condition for stopping the generation when there are tool results in the last step.
   * When the condition is an array, any of the conditions can be met to stop the generation.
   */
  stopWhen?:
    | StopCondition<NoInfer<ToolSet>>
    | Array<StopCondition<NoInfer<ToolSet>>>;
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
 *   writable: getWritable<UIMessageChunk>(),
 * });
 * ```
 */
export class DurableAgent {
  private model: string | (() => Promise<LanguageModelV2>);
  private tools: ToolSet;
  private system?: string;

  constructor(options: DurableAgentOptions) {
    this.model = options.model;
    this.tools = options.tools ?? {};
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

    const iterator = streamTextIterator({
      model: this.model,
      tools: this.tools,
      writable: options.writable,
      prompt: modelPrompt,
      stopConditions: options.stopWhen,
      sendStart: options.sendStart ?? true,
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

    const sendFinish = options.sendFinish ?? true;
    const preventClose = options.preventClose ?? false;

    // Only call closeStream if there's something to do
    if (sendFinish || !preventClose) {
      await closeStream(options.writable, preventClose, sendFinish);
    }

    // The iterator returns the final conversation prompt (LanguageModelV2Prompt)
    // which is compatible with ModelMessage[]
    const messages = result.value as ModelMessage[];

    return { messages };
  }
}

async function closeStream(
  writable: WritableStream<UIMessageChunk>,
  preventClose?: boolean,
  sendFinish?: boolean
) {
  'use step';

  // Conditionally write the finish chunk
  if (sendFinish) {
    const writer = writable.getWriter();
    try {
      await writer.write({ type: 'finish' });
    } finally {
      writer.releaseLock();
    }
  }

  // Conditionally close the stream
  if (!preventClose) {
    await writable.close();
  }
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

  try {
    const toolResult = await tool.execute(input.value, {
      toolCallId: toolCall.toolCallId,
      // TODO: pass the proper messages to the tool (we'd need to pass them through the iterator)
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
  } catch (error) {
    // If it's a FatalError, convert it to a tool error result that gets sent back to the LLM
    // This mimics AI SDK behavior where tool call failures are propagated back to the model
    if (FatalError.is(error)) {
      return {
        type: 'tool-result',
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output: {
          type: 'error-text',
          value: error.message,
        },
      };
    }
    // This should technically never happen, since any error that's not FatalError would be caught in the step boundary and re-try the step
    throw error;
  }
}
