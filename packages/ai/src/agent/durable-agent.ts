import type {
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from '@ai-sdk/provider';
import {
  asSchema,
  type ModelMessage,
  type StepResult,
  type StopCondition,
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

  /**
   * Condition for stopping the generation when there are tool results in the last step.
   * When the condition is an array, any of the conditions can be met to stop the generation.
   *
   * @default stepCountIs(1)
   */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
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

  /**
   * If true, prevents the writable stream from being closed after streaming completes.
   * Defaults to false (stream will be closed).
   */
  preventClose?: boolean;

  /**
   * Condition for stopping the generation when there are tool results in the last step.
   * When the condition is an array, any of the conditions can be met to stop the generation.
   * If provided, overrides the stopWhen from the constructor.
   *
   * @default stepCountIs(1)
   */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
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
  private stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;

  constructor(options: DurableAgentOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.system = options.system;
    this.stopWhen = options.stopWhen;
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

    // Use the stopWhen from options if provided, otherwise use the one from constructor
    const stopWhen = options.stopWhen ?? this.stopWhen;
    const steps: Array<StepResult<ToolSet>> = [];

    let result = await iterator.next();
    while (!result.done) {
      const toolCalls = result.value;
      const toolResults = await Promise.all(
        toolCalls.map(
          (toolCall): Promise<LanguageModelV2ToolResultPart> =>
            executeTool(toolCall, this.tools)
        )
      );

      // Build a step result to track progress
      const stepResult = buildStepResult(toolCalls, toolResults);
      steps.push(stepResult);

      // Check stop conditions if defined
      if (stopWhen) {
        const shouldStop = await evaluateStopConditions(stopWhen, steps);
        if (shouldStop) {
          break;
        }
      }

      result = await iterator.next(toolResults);
    }

    if (!options.preventClose) {
      await closeStream(writable);
    }
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

/**
 * Evaluates stop conditions and returns true if any condition is met
 */
async function evaluateStopConditions(
  stopWhen: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>,
  steps: Array<StepResult<ToolSet>>
): Promise<boolean> {
  const conditions = Array.isArray(stopWhen) ? stopWhen : [stopWhen];

  for (const condition of conditions) {
    const result = await condition({ steps });
    if (result) {
      return true;
    }
  }

  return false;
}

/**
 * Builds a StepResult from tool calls and results
 */
function buildStepResult(
  toolCalls: LanguageModelV2ToolCall[],
  toolResults: LanguageModelV2ToolResultPart[]
): StepResult<ToolSet> {
  // Build a minimal StepResult that contains the essential information
  // The AI SDK's StepResult type has many fields, but for stopWhen evaluation,
  // the most important ones are toolCalls and toolResults

  // Create a map of toolCallId to toolCall for easier lookup
  const toolCallMap = new Map(toolCalls.map((tc) => [tc.toolCallId, tc]));

  return {
    content: [],
    text: '',
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: toolCalls.map((tc) => ({
      type: 'tool-call' as const,
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: JSON.parse(tc.input || '{}'),
    })),
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: toolResults.map((tr) => {
      const toolCall = toolCallMap.get(tr.toolCallId);
      return {
        type: 'tool-result' as const,
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        input: toolCall ? JSON.parse(toolCall.input || '{}') : {},
        output:
          tr.output.type === 'text'
            ? JSON.parse(tr.output.value)
            : tr.output.value,
      };
    }),
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: 'tool-calls' as const,
    warnings: undefined,
    request: {} as any,
    response: {} as any,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    rawResponse: undefined,
    logprobs: undefined,
    experimental_providerMetadata: undefined,
    providerMetadata: undefined,
  } as StepResult<ToolSet>;
}
