import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultPart,
} from '@ai-sdk/provider';
import type {
  FinishReason,
  StepResult,
  StreamTextOnStepFinishCallback,
  ToolChoice,
  ToolSet,
  UIMessageChunk,
} from 'ai';
import {
  type DoStreamStepRawResult,
  doStreamStep,
  type ModelStopCondition,
  normalizeFinishReason as normalizeFinishReasonStrict,
  type ProviderExecutedToolResult,
} from './do-stream-step.js';
import type {
  GenerationSettings,
  PrepareStepCallback,
  StreamTextOnErrorCallback,
  StreamTextTransform,
  TelemetrySettings,
} from './durable-agent.js';
import { safeParseToolCallInput } from './safe-parse-tool-call-input.js';
import {
  createSpan,
  endSpan,
  runInContext,
  type SpanHandle,
} from './telemetry.js';
import { toolsToModelTools } from './tools-to-model-tools.js';
import type { CompatibleLanguageModel } from './types.js';

// Re-export for consumers
export type { ProviderExecutedToolResult } from './do-stream-step.js';

/**
 * The value yielded by the stream text iterator when tool calls are requested.
 * Contains both the tool calls and the current conversation messages.
 */
export interface StreamTextIteratorYieldValue {
  /** The tool calls requested by the model */
  toolCalls: LanguageModelV3ToolCall[];
  /** The conversation messages up to (and including) the tool call request */
  messages: LanguageModelV3Prompt;
  /** The step result from the current step */
  step?: StepResult<ToolSet>;
  /** The current experimental context */
  context?: unknown;
  /** The UIMessageChunks written during this step (only when collectUIChunks is enabled) */
  uiChunks?: UIMessageChunk[];
  /** Provider-executed tool results (keyed by tool call ID) */
  providerExecutedToolResults?: Map<string, ProviderExecutedToolResult>;
  /**
   * The outer `ai.streamText` span handle. Callers should wrap tool execution
   * in `runInContext(spanHandle, ...)` so that `ai.toolCall` spans parent
   * correctly under the `ai.streamText` span. OTel context does not propagate
   * across generator yield boundaries, so we pass it explicitly.
   */
  spanHandle?: SpanHandle;
}

// This runs in the workflow context
export async function* streamTextIterator({
  prompt,
  tools = {},
  writable,
  model,
  stopConditions,
  maxSteps,
  sendStart = true,
  onStepFinish,
  onError,
  prepareStep,
  generationSettings,
  toolChoice,
  experimental_context,
  experimental_telemetry,
  includeRawChunks = false,
  experimental_transform,
  responseFormat,
  collectUIChunks = false,
}: {
  prompt: LanguageModelV3Prompt;
  tools: ToolSet;
  writable: WritableStream<UIMessageChunk>;
  model: string | (() => Promise<CompatibleLanguageModel>);
  stopConditions?: ModelStopCondition[] | ModelStopCondition;
  maxSteps?: number;
  sendStart?: boolean;
  onStepFinish?: StreamTextOnStepFinishCallback<any>;
  onError?: StreamTextOnErrorCallback;
  prepareStep?: PrepareStepCallback<any>;
  generationSettings?: GenerationSettings;
  toolChoice?: ToolChoice<ToolSet>;
  experimental_context?: unknown;
  experimental_telemetry?: TelemetrySettings;
  includeRawChunks?: boolean;
  experimental_transform?:
    | StreamTextTransform<ToolSet>
    | Array<StreamTextTransform<ToolSet>>;
  responseFormat?: LanguageModelV3CallOptions['responseFormat'];
  /** If true, collects UIMessageChunks for later conversion to UIMessage[] */
  collectUIChunks?: boolean;
}): AsyncGenerator<
  StreamTextIteratorYieldValue,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultPart[]
> {
  let conversationPrompt = [...prompt]; // Create a mutable copy
  let currentModel: string | (() => Promise<CompatibleLanguageModel>) = model;
  let currentGenerationSettings = generationSettings ?? {};
  let currentToolChoice = toolChoice;
  let currentContext = experimental_context;
  let currentActiveTools: string[] | undefined;

  const steps: StepResult<any>[] = [];
  let done = false;
  let isFirstIteration = true;
  let stepNumber = 0;
  let lastStep: StepResult<any> | undefined;
  let lastStepWasToolCalls = false;
  let lastStepUIChunks: UIMessageChunk[] | undefined;
  let allAccumulatedUIChunks: UIMessageChunk[] = [];

  // Outer ai.streamText span matching AI SDK convention.
  // Uses JSON.stringify({ prompt }) (wrapped object) to match the AI SDK's
  // convention for the outer span, whereas the inner doStream span uses
  // JSON.stringify(conversationPrompt) (bare array) for ai.prompt.messages.
  const outerSpanHandle = await createSpan({
    name: 'ai.streamText',
    telemetry: experimental_telemetry,
    attributes: {
      // Input attributes (gated on recordInputs)
      ...(experimental_telemetry?.recordInputs !== false && {
        'ai.prompt': JSON.stringify({ prompt }),
      }),
    },
  });
  let outerSpanError: unknown;

  // Default maxSteps to Infinity to preserve backwards compatibility
  // (agent loops until completion unless explicitly limited)
  const effectiveMaxSteps = maxSteps ?? Infinity;

  // Convert transforms to array
  const transforms = experimental_transform
    ? Array.isArray(experimental_transform)
      ? experimental_transform
      : [experimental_transform]
    : [];

  try {
    while (!done) {
      // Check if we've exceeded the maximum number of steps
      if (stepNumber >= effectiveMaxSteps) {
        break;
      }

      // Check for abort signal
      if (currentGenerationSettings.abortSignal?.aborted) {
        break;
      }

      // Call prepareStep callback before each step if provided
      if (prepareStep) {
        const prepareResult = await prepareStep({
          model: currentModel,
          stepNumber,
          steps,
          messages: conversationPrompt,
          experimental_context: currentContext,
        });

        // Apply any overrides from prepareStep
        if (prepareResult.model !== undefined) {
          currentModel = prepareResult.model;
        }
        if (prepareResult.messages !== undefined) {
          conversationPrompt = [...prepareResult.messages];
        }
        if (prepareResult.system !== undefined) {
          // Update or prepend system message in the conversation prompt.
          // Applied AFTER messages override so the system message isn't
          // lost when messages replaces the prompt.
          if (
            conversationPrompt.length > 0 &&
            conversationPrompt[0].role === 'system'
          ) {
            // Replace existing system message
            conversationPrompt[0] = {
              role: 'system',
              content: prepareResult.system,
            };
          } else {
            // Prepend new system message
            conversationPrompt.unshift({
              role: 'system',
              content: prepareResult.system,
            });
          }
        }
        if (prepareResult.experimental_context !== undefined) {
          currentContext = prepareResult.experimental_context;
        }
        if (prepareResult.activeTools !== undefined) {
          currentActiveTools = prepareResult.activeTools;
        }
        // Apply generation settings overrides
        if (prepareResult.maxOutputTokens !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            maxOutputTokens: prepareResult.maxOutputTokens,
          };
        }
        if (prepareResult.temperature !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            temperature: prepareResult.temperature,
          };
        }
        if (prepareResult.topP !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            topP: prepareResult.topP,
          };
        }
        if (prepareResult.topK !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            topK: prepareResult.topK,
          };
        }
        if (prepareResult.presencePenalty !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            presencePenalty: prepareResult.presencePenalty,
          };
        }
        if (prepareResult.frequencyPenalty !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            frequencyPenalty: prepareResult.frequencyPenalty,
          };
        }
        if (prepareResult.stopSequences !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            stopSequences: prepareResult.stopSequences,
          };
        }
        if (prepareResult.seed !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            seed: prepareResult.seed,
          };
        }
        if (prepareResult.maxRetries !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            maxRetries: prepareResult.maxRetries,
          };
        }
        if (prepareResult.headers !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            headers: prepareResult.headers,
          };
        }
        if (prepareResult.providerOptions !== undefined) {
          currentGenerationSettings = {
            ...currentGenerationSettings,
            providerOptions: prepareResult.providerOptions,
          };
        }
        if (prepareResult.toolChoice !== undefined) {
          currentToolChoice = prepareResult.toolChoice;
        }
      }

      try {
        // Filter tools if activeTools is specified
        const effectiveTools =
          currentActiveTools && currentActiveTools.length > 0
            ? filterToolSet(tools, currentActiveTools)
            : tools;

        // Wrap doStreamStep in the outer span's context so that inner
        // spans (ai.streamText.doStream) parent under ai.streamText.
        // Each call is wrapped individually because context.with() does
        // not propagate across generator yield boundaries.
        const modelTools = await toolsToModelTools(effectiveTools);
        const {
          toolCalls,
          raw,
          uiChunks: stepUIChunks,
          providerExecutedToolResults,
        } = await runInContext(outerSpanHandle, () =>
          doStreamStep(conversationPrompt, currentModel, writable, modelTools, {
            sendStart: sendStart && isFirstIteration,
            ...currentGenerationSettings,
            toolChoice: currentToolChoice,
            includeRawChunks,
            experimental_telemetry,
            transforms,
            responseFormat,
            collectUIChunks,
          })
        );
        // Reconstruct the full StepResult outside the step boundary so the
        // event log doesn't carry StepResult's redundant copies.
        const step = buildStepResult(raw, toolCalls, conversationPrompt);
        isFirstIteration = false;
        stepNumber++;
        steps.push(step);
        lastStep = step;
        lastStepWasToolCalls = false;
        lastStepUIChunks = stepUIChunks;

        // Aggregate UIChunks from this step (may include tool output chunks later)
        let allStepUIChunks = [
          ...allAccumulatedUIChunks,
          ...(stepUIChunks ?? []),
        ];

        // Normalize finishReason - AI SDK v6 returns { unified, raw }, v5 returns a string
        const finishReason = normalizeFinishReason(raw.rawFinishReason);

        if (finishReason === 'tool-calls' || toolCalls.length > 0) {
          lastStepWasToolCalls = true;

          // Build reasoning content parts from the step result.
          // Preserving reasoning in the conversation prompt mirrors what the
          // AI SDK's toResponseMessages() does, so reasoning models retain
          // access to their prior reasoning across multi-step tool loops.
          const reasoningParts = (step.reasoning ?? []).map((r) => ({
            type: 'reasoning' as const,
            text: r.text,
            ...(r.providerOptions != null
              ? { providerOptions: r.providerOptions }
              : {}),
          }));

          // Add assistant message with reasoning + tool calls to the conversation.
          // providerMetadata from each tool call is mapped to providerOptions in
          // the prompt format, following the AI SDK convention. This is critical
          // for providers like Gemini that require thoughtSignature to be preserved
          // across multi-turn tool calls.
          conversationPrompt.push({
            role: 'assistant',
            content: [
              ...reasoningParts,
              ...toolCalls.map((toolCall) => {
                const meta = toolCall.providerMetadata as
                  | Record<string, unknown>
                  | undefined;
                return {
                  type: 'tool-call' as const,
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: safeParseToolCallInput(toolCall.input),
                  ...(meta != null ? { providerOptions: meta } : {}),
                };
              }),
            ] as Extract<
              LanguageModelV3Prompt[number],
              { role: 'assistant' }
            >['content'],
          });

          // Yield the tool calls along with the current conversation messages
          // This allows executeTool to pass the conversation context to tool execute functions
          // Also include provider-executed tool results so they can be used instead of local execution
          const toolResults = yield {
            toolCalls,
            messages: conversationPrompt,
            step,
            context: currentContext,
            uiChunks: allStepUIChunks,
            providerExecutedToolResults,
            spanHandle: outerSpanHandle,
          };

          const toolOutputChunks = await writeToolOutputToUI(
            writable,
            toolResults,
            collectUIChunks
          );
          // Merge tool output chunks into allStepUIChunks for the next iteration
          if (collectUIChunks && toolOutputChunks.length > 0) {
            allStepUIChunks = [...(allStepUIChunks ?? []), ...toolOutputChunks];
            // Also accumulate for future steps
            allAccumulatedUIChunks = [
              ...allAccumulatedUIChunks,
              ...toolOutputChunks,
            ];
          }

          conversationPrompt.push({
            role: 'tool',
            content: toolResults,
          });

          if (stopConditions) {
            const stopConditionList = Array.isArray(stopConditions)
              ? stopConditions
              : [stopConditions];
            if (stopConditionList.some((test) => test({ steps }))) {
              done = true;
            }
          }
        } else if (finishReason === 'stop') {
          // Add assistant message with text content to the conversation
          const textContent = step.content.filter(
            (item) => item.type === 'text'
          ) as Array<{ type: 'text'; text: string }>;

          if (textContent.length > 0) {
            conversationPrompt.push({
              role: 'assistant',
              content: textContent,
            });
          }

          done = true;
        } else if (finishReason === 'length') {
          // Model hit max tokens - stop but don't throw
          done = true;
        } else if (finishReason === 'content-filter') {
          // Content filter triggered - stop but don't throw
          done = true;
        } else if (finishReason === 'error') {
          // Model error - stop but don't throw
          done = true;
        } else if (finishReason === 'other') {
          // Other reason - stop but don't throw
          done = true;
        } else if (finishReason === 'unknown') {
          // Unknown reason - stop but don't throw
          done = true;
        } else if (!finishReason) {
          // No finish reason - this might happen on incomplete streams
          done = true;
        } else {
          throw new Error(
            `Unexpected finish reason: ${typeof raw.rawFinishReason === 'object' ? JSON.stringify(raw.rawFinishReason) : raw.rawFinishReason}`
          );
        }

        if (onStepFinish) {
          await onStepFinish(step);
        }
      } catch (error) {
        if (onError) {
          await onError({ error });
        }
        throw error;
      }
    }

    // Yield the final step if it wasn't already yielded (tool-calls steps are yielded inside the loop)
    if (lastStep && !lastStepWasToolCalls) {
      const finalUIChunks = [
        ...allAccumulatedUIChunks,
        ...(lastStepUIChunks ?? []),
      ];
      yield {
        toolCalls: [],
        messages: conversationPrompt,
        step: lastStep,
        context: currentContext,
        uiChunks: finalUIChunks,
        spanHandle: outerSpanHandle,
      };
    }
  } catch (error) {
    outerSpanError = error;
    throw error;
  } finally {
    // End the outer ai.streamText span with aggregated attributes
    if (outerSpanHandle) {
      // Aggregate usage across all steps
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      for (const step of steps) {
        totalInputTokens += step.usage?.inputTokens ?? 0;
        totalOutputTokens += step.usage?.outputTokens ?? 0;
      }

      const finalStep = steps[steps.length - 1];
      const attrs: Record<string, unknown> = {
        'ai.response.finishReason': finalStep?.finishReason,
        'ai.usage.inputTokens': totalInputTokens,
        'ai.usage.outputTokens': totalOutputTokens,
        'ai.usage.totalTokens': totalInputTokens + totalOutputTokens,
      };

      // Output-gated attributes
      if (experimental_telemetry?.recordOutputs !== false && finalStep) {
        if (finalStep.text) {
          attrs['ai.response.text'] = finalStep.text;
        }
        if (finalStep.toolCalls && finalStep.toolCalls.length > 0) {
          attrs['ai.response.toolCalls'] = JSON.stringify(finalStep.toolCalls);
        }
      }

      outerSpanHandle.span.setAttributes(attrs);
      endSpan(outerSpanHandle.span, outerSpanError);
    }
  }

  return conversationPrompt;
}

async function writeToolOutputToUI(
  writable: WritableStream<UIMessageChunk>,
  toolResults: LanguageModelV3ToolResultPart[],
  collectUIChunks?: boolean
): Promise<UIMessageChunk[]> {
  'use step';
  const writer = writable.getWriter();
  const chunks: UIMessageChunk[] = [];
  try {
    for (const result of toolResults) {
      const chunk: UIMessageChunk = {
        type: 'tool-output-available' as const,
        toolCallId: result.toolCallId,
        output: 'value' in result.output ? result.output.value : undefined,
      };
      if (collectUIChunks) {
        chunks.push(chunk);
      }
      await writer.write(chunk);
    }
  } finally {
    writer.releaseLock();
  }
  return chunks;
}

/**
 * Filter a tool set to only include the specified active tools.
 */
function filterToolSet(tools: ToolSet, activeTools: string[]): ToolSet {
  const filtered: ToolSet = {};
  for (const toolName of activeTools) {
    if (toolName in tools) {
      filtered[toolName] = tools[toolName];
    }
  }
  return filtered;
}

/**
 * Normalize finishReason from different AI SDK versions.
 * - AI SDK v6: returns { unified: 'tool-calls', raw: 'tool_use' }
 * - AI SDK v5: returns 'tool-calls' string directly
 */
function normalizeFinishReason(raw: unknown): FinishReason | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw as FinishReason;
  if (typeof raw === 'object') {
    const obj = raw as { unified?: FinishReason; type?: FinishReason };
    return obj.unified ?? obj.type ?? 'other';
  }
  return undefined;
}

/**
 * Convert a Uint8Array to a base64 string safely.
 * Uses a loop instead of spread operator to avoid stack overflow on large arrays.
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

/**
 * Reconstruct a full `StepResult` from the minimal raw aggregates returned
 * by `doStreamStep`. Runs outside the step boundary so StepResult's
 * redundant fields (duplicate tool-call lists, content, reasoningText,
 * dual base64+uint8Array file encoding, request body) don't cross it.
 *
 * The shape returned matches what the AI SDK's `streamText` would expose
 * to user callbacks (`onStepFinish`, the `steps` array).
 */
function buildStepResult(
  raw: DoStreamStepRawResult,
  toolCalls: LanguageModelV3ToolCall[],
  conversationPrompt: LanguageModelV3Prompt
): StepResult<any> {
  const reasoning = raw.reasoning.map((r) => ({
    type: 'reasoning' as const,
    text: r.text,
    ...(r.providerMetadata != null
      ? { providerOptions: r.providerMetadata }
      : {}),
  }));

  const reasoningText = raw.reasoning.map((r) => r.text).join('');

  // Expand each file to the AI SDK's GeneratedFile shape (base64 + uint8Array).
  // The dual encoding doubles the file payload, so we only do it here, after
  // crossing the step boundary.
  const files = raw.files.map((file) => {
    const data = file.data;
    if (data instanceof Uint8Array) {
      const base64 = uint8ArrayToBase64(data);
      return {
        mediaType: file.mediaType,
        base64,
        uint8Array: data,
      };
    } else {
      // Data is a base64 string.
      const binaryString = atob(data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return {
        mediaType: file.mediaType,
        base64: data,
        uint8Array: bytes,
      };
    }
  });

  // Extract the raw finish reason from the V3 finish reason object/string.
  const rawFinish = raw.rawFinishReason;
  const rawFinishReason =
    typeof rawFinish === 'object' && rawFinish !== null
      ? (rawFinish as { raw?: string }).raw
      : typeof rawFinish === 'string'
        ? rawFinish
        : undefined;

  const mapToolCall = (toolCall: LanguageModelV3ToolCall) => ({
    type: 'tool-call' as const,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: safeParseToolCallInput(toolCall.input),
    dynamic: true as const,
  });

  return {
    stepNumber: 0, // Will be overridden by the caller
    model: {
      provider: raw.responseMetadata?.modelId?.split(':')[0] ?? 'unknown',
      modelId: raw.responseMetadata?.modelId ?? 'unknown',
    },
    functionId: undefined,
    metadata: undefined,
    experimental_context: undefined,
    content: [
      ...(raw.text ? [{ type: 'text' as const, text: raw.text }] : []),
      ...toolCalls.map(mapToolCall),
    ],
    text: raw.text,
    reasoning,
    reasoningText: reasoningText || undefined,
    files,
    sources: raw.sources,
    toolCalls: toolCalls.map(mapToolCall),
    staticToolCalls: [],
    dynamicToolCalls: toolCalls.map(mapToolCall),
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: normalizeFinishReasonStrict(raw.rawFinishReason),
    rawFinishReason,
    usage: raw.usage
      ? {
          inputTokens: raw.usage.inputTokens?.total ?? 0,
          inputTokenDetails: {
            noCacheTokens: raw.usage.inputTokens?.noCache,
            cacheReadTokens: raw.usage.inputTokens?.cacheRead,
            cacheWriteTokens: raw.usage.inputTokens?.cacheWrite,
          },
          outputTokens: raw.usage.outputTokens?.total ?? 0,
          outputTokenDetails: {
            textTokens: raw.usage.outputTokens?.text,
            reasoningTokens: raw.usage.outputTokens?.reasoning,
          },
          totalTokens:
            (raw.usage.inputTokens?.total ?? 0) +
            (raw.usage.outputTokens?.total ?? 0),
          // Deprecated flat aliases, kept in sync with the nested details so
          // step.usage matches the AI SDK's asLanguageModelUsage shape.
          reasoningTokens: raw.usage.outputTokens?.reasoning,
          cachedInputTokens: raw.usage.inputTokens?.cacheRead,
        }
      : {
          inputTokens: 0,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 0,
          outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: undefined,
          },
          totalTokens: 0,
        },
    warnings: raw.warnings,
    request: {
      body: JSON.stringify({
        prompt: conversationPrompt,
        tools: toolCalls.map(mapToolCall),
      }),
    },
    response: {
      id: raw.responseMetadata?.id ?? 'unknown',
      timestamp:
        raw.responseMetadata?.timestamp instanceof Date
          ? raw.responseMetadata.timestamp
          : raw.responseMetadata?.timestamp != null
            ? new Date(raw.responseMetadata.timestamp)
            : new Date(),
      modelId: raw.responseMetadata?.modelId ?? 'unknown',
      messages: [],
    },
    providerMetadata: raw.providerMetadata || {},
  };
}
