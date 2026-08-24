import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolChoice,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import {
  type FinishReason,
  gateway,
  generateId,
  type StopCondition,
  type ToolChoice,
  type ToolSet,
  type UIMessageChunk,
} from 'ai';
import { getErrorMessage } from '../get-error-message.js';
import type {
  ProviderOptions,
  StreamTextTransform,
  TelemetrySettings,
} from './durable-agent.js';
import { safeParseToolCallInput } from './safe-parse-tool-call-input.js';
import { recordSpan } from './telemetry.js';
import type { CompatibleLanguageModel } from './types.js';

export type FinishPart = Extract<LanguageModelV3StreamPart, { type: 'finish' }>;

export type ModelStopCondition = StopCondition<NoInfer<ToolSet>>;

/**
 * Provider-executed tool result captured from the stream.
 */
export interface ProviderExecutedToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
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
 * Reasoning part captured during streaming, in source order.
 */
export interface RawReasoningPart {
  text: string;
  providerMetadata?: SharedV3ProviderOptions;
}

/**
 * File chunk captured during streaming. `data` is the raw value emitted by the
 * model — a base64 string or a Uint8Array. The type is derived from the V3 file
 * stream part so it tracks the SDK: if a future provider version widens it (e.g.
 * a URL), `buildStepResult`'s base64 decode path stops type-checking and forces
 * us to handle the new shape rather than silently corrupting it.
 */
export interface RawFile {
  mediaType: string;
  data: Extract<LanguageModelV3StreamPart, { type: 'file' }>['data'];
}

/**
 * Response metadata extracted from the model's `response-metadata` chunk.
 */
export interface RawResponseMetadata {
  id?: string;
  modelId?: string;
  timestamp?: Date | string;
}

/**
 * Minimal aggregates needed to reconstruct a `StepResult` outside the step
 * boundary. By returning only these fields (instead of a fully-populated
 * StepResult), we avoid serializing the redundant copies the AI SDK keeps
 * in StepResult — `toolCalls`/`dynamicToolCalls`/`staticToolCalls`,
 * `content`, `reasoningText`, the always-empty `*ToolResults` arrays, the
 * dual base64+uint8Array file encoding, and `request.body` (a JSON dump of
 * the input prompt). The caller reconstructs the full StepResult from
 * these fields plus the conversation prompt it already holds.
 */
export interface DoStreamStepRawResult {
  text: string;
  reasoning: RawReasoningPart[];
  files: RawFile[];
  sources: Array<Extract<LanguageModelV3StreamPart, { type: 'source' }>>;
  warnings?: Extract<
    LanguageModelV3StreamPart,
    { type: 'stream-start' }
  >['warnings'];
  responseMetadata?: RawResponseMetadata;
  /** Raw finish reason as emitted by the model (V3 may emit object or string). */
  rawFinishReason: unknown;
  usage?: FinishPart['usage'];
  providerMetadata?: SharedV3ProviderOptions;
}

/**
 * Result returned across the `doStreamStep` step boundary.
 */
export interface DoStreamStepResult {
  toolCalls: LanguageModelV3ToolCall[];
  raw: DoStreamStepRawResult;
  uiChunks: UIMessageChunk[] | undefined;
  providerExecutedToolResults: Map<string, ProviderExecutedToolResult>;
}

/**
 * Options for the doStreamStep function.
 */
export interface DoStreamStepOptions {
  sendStart?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  maxRetries?: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
  providerOptions?: ProviderOptions;
  toolChoice?: ToolChoice<ToolSet>;
  includeRawChunks?: boolean;
  experimental_telemetry?: TelemetrySettings;
  transforms?: Array<StreamTextTransform<ToolSet>>;
  responseFormat?: LanguageModelV3CallOptions['responseFormat'];
  /**
   * If true, collects and returns all UIMessageChunks written to the stream.
   * This is used by DurableAgent when collectUIMessages is enabled.
   */
  collectUIChunks?: boolean;
}

/**
 * Convert AI SDK ToolChoice to LanguageModelV3ToolChoice
 */
function toLanguageModelToolChoice(
  toolChoice: ToolChoice<ToolSet> | undefined
): LanguageModelV3ToolChoice | undefined {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (toolChoice === 'auto') {
    return { type: 'auto' };
  }
  if (toolChoice === 'none') {
    return { type: 'none' };
  }
  if (toolChoice === 'required') {
    return { type: 'required' };
  }
  if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
    return { type: 'tool', toolName: toolChoice.toolName };
  }
  return undefined;
}

export async function doStreamStep(
  conversationPrompt: LanguageModelV3Prompt,
  modelInit: string | (() => Promise<CompatibleLanguageModel>),
  writable: WritableStream<UIMessageChunk>,
  tools?: LanguageModelV3CallOptions['tools'],
  options?: DoStreamStepOptions
): Promise<DoStreamStepResult> {
  'use step';

  let model: CompatibleLanguageModel | undefined;
  if (typeof modelInit === 'string') {
    model = gateway(modelInit) as CompatibleLanguageModel;
  } else if (typeof modelInit === 'function') {
    // User-provided model factory - returns V3
    model = await modelInit();
  } else {
    throw new Error(
      'Invalid "model initialization" argument. Must be a string or a function that returns a LanguageModel instance.'
    );
  }

  // Build call options with all generation settings
  const callOptions: LanguageModelV3CallOptions = {
    prompt: conversationPrompt,
    tools,
    ...(options?.maxOutputTokens !== undefined && {
      maxOutputTokens: options.maxOutputTokens,
    }),
    ...(options?.temperature !== undefined && {
      temperature: options.temperature,
    }),
    ...(options?.topP !== undefined && { topP: options.topP }),
    ...(options?.topK !== undefined && { topK: options.topK }),
    ...(options?.presencePenalty !== undefined && {
      presencePenalty: options.presencePenalty,
    }),
    ...(options?.frequencyPenalty !== undefined && {
      frequencyPenalty: options.frequencyPenalty,
    }),
    ...(options?.stopSequences !== undefined && {
      stopSequences: options.stopSequences,
    }),
    ...(options?.seed !== undefined && { seed: options.seed }),
    ...(options?.abortSignal !== undefined && {
      abortSignal: options.abortSignal,
    }),
    ...(options?.headers !== undefined && { headers: options.headers }),
    ...(options?.providerOptions !== undefined && {
      providerOptions: options.providerOptions as SharedV3ProviderOptions,
    }),
    ...(options?.toolChoice !== undefined && {
      toolChoice: toLanguageModelToolChoice(options.toolChoice),
    }),
    ...(options?.includeRawChunks !== undefined && {
      includeRawChunks: options.includeRawChunks,
    }),
    ...(options?.responseFormat !== undefined && {
      responseFormat: options.responseFormat,
    }),
  };

  const telemetry = options?.experimental_telemetry;

  return await recordSpan({
    name: 'ai.streamText.doStream',
    telemetry,
    attributes: {
      'ai.model.provider': model.provider,
      'ai.model.id': model.modelId,
      // gen_ai semantic convention attributes
      'gen_ai.system': model.provider,
      'gen_ai.request.model': model.modelId,
      ...(options?.maxOutputTokens !== undefined && {
        'gen_ai.request.max_tokens': options.maxOutputTokens,
      }),
      ...(options?.temperature !== undefined && {
        'gen_ai.request.temperature': options.temperature,
      }),
      ...(options?.topP !== undefined && {
        'gen_ai.request.top_p': options.topP,
      }),
      ...(options?.topK !== undefined && {
        'gen_ai.request.top_k': options.topK,
      }),
      ...(options?.frequencyPenalty !== undefined && {
        'gen_ai.request.frequency_penalty': options.frequencyPenalty,
      }),
      ...(options?.presencePenalty !== undefined && {
        'gen_ai.request.presence_penalty': options.presencePenalty,
      }),
      ...(options?.stopSequences !== undefined && {
        'gen_ai.request.stop_sequences': options.stopSequences,
      }),
      // Input attributes (gated on recordInputs)
      ...(telemetry?.recordInputs !== false && {
        'ai.prompt.messages': JSON.stringify(conversationPrompt),
        ...(tools && { 'ai.prompt.tools': JSON.stringify(tools) }),
        ...(options?.toolChoice !== undefined && {
          'ai.prompt.toolChoice': JSON.stringify(options.toolChoice),
        }),
      }),
    },
    fn: async (span) => {
      const startTime = Date.now();
      const result = await model!.doStream(callOptions);

      let finish: FinishPart | undefined;
      const toolCalls: LanguageModelV3ToolCall[] = [];
      // Map of tool call ID to provider-executed tool result
      const providerExecutedToolResults = new Map<
        string,
        ProviderExecutedToolResult
      >();

      // Raw aggregates streamed in alongside chunks. We collect these here
      // so we don't have to retain the full V3 chunk array, and so callers
      // outside the step boundary can rebuild a StepResult without paying
      // for StepResult's redundant fields across the boundary.
      let textBuffer = '';
      const reasoningById = new Map<
        string,
        { text: string; providerMetadata?: SharedV3ProviderOptions }
      >();
      const reasoningOrder: string[] = [];
      const files: RawFile[] = [];
      const sources: Array<
        Extract<LanguageModelV3StreamPart, { type: 'source' }>
      > = [];
      let warnings:
        | Extract<
            LanguageModelV3StreamPart,
            { type: 'stream-start' }
          >['warnings']
        | undefined;
      let responseMetadata: RawResponseMetadata | undefined;

      const includeRawChunks = options?.includeRawChunks ?? false;
      const collectUIChunks = options?.collectUIChunks ?? false;
      const uiChunks: UIMessageChunk[] = [];
      let msToFirstChunk: number | undefined;

      // Build the stream pipeline
      let stream: ReadableStream<LanguageModelV3StreamPart> = result.stream;

      // Apply custom transforms if provided
      if (options?.transforms && options.transforms.length > 0) {
        let terminated = false;
        const stopStream = () => {
          terminated = true;
        };

        for (const transform of options.transforms) {
          if (!terminated) {
            stream = stream.pipeThrough(
              transform({
                tools: {} as ToolSet, // Note: toolSet not available inside step boundary due to serialization
                stopStream,
              })
            );
          }
        }
      }

      await stream
        .pipeThrough(
          new TransformStream({
            async transform(chunk, controller) {
              if (msToFirstChunk === undefined) {
                msToFirstChunk = Date.now() - startTime;
              }
              switch (chunk.type) {
                case 'tool-call':
                  toolCalls.push({
                    ...chunk,
                    input: chunk.input || '{}',
                  });
                  break;
                case 'tool-result':
                  // In V3, all tool-result stream parts are provider-executed by definition
                  providerExecutedToolResults.set(chunk.toolCallId, {
                    toolCallId: chunk.toolCallId,
                    toolName: chunk.toolName,
                    result: chunk.result,
                    isError: chunk.isError,
                  });
                  break;
                case 'finish':
                  finish = chunk;
                  break;
                case 'text-delta':
                  textBuffer += chunk.delta;
                  break;
                case 'reasoning-start':
                  reasoningById.set(chunk.id, {
                    text: '',
                    providerMetadata: chunk.providerMetadata as
                      | SharedV3ProviderOptions
                      | undefined,
                  });
                  reasoningOrder.push(chunk.id);
                  break;
                case 'reasoning-delta': {
                  const entry = reasoningById.get(chunk.id);
                  if (entry) {
                    entry.text += chunk.delta;
                    if (chunk.providerMetadata != null) {
                      entry.providerMetadata =
                        chunk.providerMetadata as SharedV3ProviderOptions;
                    }
                  } else {
                    // Delta without a preceding start — still collect it
                    reasoningById.set(chunk.id, {
                      text: chunk.delta,
                      providerMetadata: chunk.providerMetadata as
                        | SharedV3ProviderOptions
                        | undefined,
                    });
                    reasoningOrder.push(chunk.id);
                  }
                  break;
                }
                case 'reasoning-end': {
                  // Mirror the AI SDK's behavior: reasoning-end can carry final providerMetadata.
                  const entry = reasoningById.get(chunk.id);
                  if (entry && chunk.providerMetadata != null) {
                    entry.providerMetadata =
                      chunk.providerMetadata as SharedV3ProviderOptions;
                  }
                  break;
                }
                case 'file':
                  files.push({
                    mediaType: chunk.mediaType,
                    data: chunk.data,
                  });
                  break;
                case 'source':
                  sources.push(chunk);
                  break;
                case 'stream-start':
                  warnings = chunk.warnings;
                  break;
                case 'response-metadata':
                  // Merge per-field, mirroring the AI SDK: a provider may emit
                  // multiple response-metadata chunks, and a later partial chunk
                  // must not clobber fields populated by an earlier one.
                  responseMetadata = {
                    id: chunk.id ?? responseMetadata?.id,
                    modelId: chunk.modelId ?? responseMetadata?.modelId,
                    timestamp: chunk.timestamp ?? responseMetadata?.timestamp,
                  };
                  break;
              }
              controller.enqueue(chunk);
            },
          })
        )
        .pipeThrough(
          new TransformStream<LanguageModelV3StreamPart, UIMessageChunk>({
            start: (controller) => {
              if (options?.sendStart) {
                controller.enqueue({
                  type: 'start',
                  // Note that if useChat is used client-side, useChat will generate a different
                  // messageId. It's hard to work around this.
                  messageId: generateId(),
                });
              }
              controller.enqueue({
                type: 'start-step',
              });
            },
            flush: (controller) => {
              controller.enqueue({
                type: 'finish-step',
              });
            },
            transform: async (part, controller) => {
              const partType = part.type;
              switch (partType) {
                case 'text-start': {
                  controller.enqueue({
                    type: 'text-start',
                    id: part.id,
                    ...(part.providerMetadata != null
                      ? { providerMetadata: part.providerMetadata }
                      : {}),
                  });
                  break;
                }

                case 'text-delta': {
                  controller.enqueue({
                    type: 'text-delta',
                    id: part.id,
                    delta: part.delta,
                    ...(part.providerMetadata != null
                      ? { providerMetadata: part.providerMetadata }
                      : {}),
                  });
                  break;
                }

                case 'text-end': {
                  controller.enqueue({
                    type: 'text-end',
                    id: part.id,
                    ...(part.providerMetadata != null
                      ? { providerMetadata: part.providerMetadata }
                      : {}),
                  });
                  break;
                }

                case 'reasoning-start': {
                  controller.enqueue({
                    type: 'reasoning-start',
                    id: part.id,
                    ...(part.providerMetadata != null
                      ? { providerMetadata: part.providerMetadata }
                      : {}),
                  });
                  break;
                }

                case 'reasoning-delta': {
                  controller.enqueue({
                    type: 'reasoning-delta',
                    id: part.id,
                    delta: part.delta,
                    ...(part.providerMetadata != null
                      ? { providerMetadata: part.providerMetadata }
                      : {}),
                  });

                  break;
                }

                case 'reasoning-end': {
                  controller.enqueue({
                    type: 'reasoning-end',
                    id: part.id,
                    ...(part.providerMetadata != null
                      ? { providerMetadata: part.providerMetadata }
                      : {}),
                  });
                  break;
                }

                case 'file': {
                  // Convert data to URL, handling Uint8Array, URL, and string cases
                  let url: string;
                  const fileData = part.data as Uint8Array | string | URL;
                  if (fileData instanceof Uint8Array) {
                    // Convert Uint8Array to base64 and create data URL
                    const base64 = uint8ArrayToBase64(fileData);
                    url = `data:${part.mediaType};base64,${base64}`;
                  } else if (fileData instanceof URL) {
                    // Use URL directly (could be a data URL or remote URL)
                    url = fileData.href;
                  } else if (
                    fileData.startsWith('data:') ||
                    fileData.startsWith('http:') ||
                    fileData.startsWith('https:')
                  ) {
                    // Already a URL string
                    url = fileData;
                  } else {
                    // Assume it's base64-encoded data
                    url = `data:${part.mediaType};base64,${fileData}`;
                  }
                  controller.enqueue({
                    type: 'file',
                    mediaType: part.mediaType,
                    url,
                  });
                  break;
                }

                case 'source': {
                  if (part.sourceType === 'url') {
                    controller.enqueue({
                      type: 'source-url',
                      sourceId: part.id,
                      url: part.url,
                      title: part.title,
                      ...(part.providerMetadata != null
                        ? { providerMetadata: part.providerMetadata }
                        : {}),
                    });
                  }

                  if (part.sourceType === 'document') {
                    controller.enqueue({
                      type: 'source-document',
                      sourceId: part.id,
                      mediaType: part.mediaType,
                      title: part.title,
                      filename: part.filename,
                      ...(part.providerMetadata != null
                        ? { providerMetadata: part.providerMetadata }
                        : {}),
                    });
                  }
                  break;
                }

                case 'tool-input-start': {
                  controller.enqueue({
                    type: 'tool-input-start',
                    toolCallId: part.id,
                    toolName: part.toolName,
                    ...(part.providerExecuted != null
                      ? { providerExecuted: part.providerExecuted }
                      : {}),
                  });
                  break;
                }

                case 'tool-input-delta': {
                  controller.enqueue({
                    type: 'tool-input-delta',
                    toolCallId: part.id,
                    inputTextDelta: part.delta,
                  });
                  break;
                }

                case 'tool-input-end': {
                  // End of tool input streaming - no UI chunk needed
                  break;
                }

                case 'tool-call': {
                  controller.enqueue({
                    type: 'tool-input-available',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: safeParseToolCallInput(part.input),
                    ...(part.providerExecuted != null
                      ? { providerExecuted: part.providerExecuted }
                      : {}),
                    ...(part.providerMetadata != null
                      ? { providerMetadata: part.providerMetadata }
                      : {}),
                  });
                  break;
                }

                case 'tool-result': {
                  controller.enqueue({
                    type: 'tool-output-available',
                    toolCallId: part.toolCallId,
                    output: part.result,
                  });
                  break;
                }

                case 'error': {
                  const error = part.error;
                  controller.enqueue({
                    type: 'error',
                    errorText: getErrorMessage(error),
                  });

                  break;
                }

                case 'stream-start': {
                  // Stream start is internal, no UI chunk needed
                  break;
                }

                case 'response-metadata': {
                  // Response metadata is internal, no UI chunk needed
                  break;
                }

                case 'finish': {
                  // Finish is handled separately
                  break;
                }

                case 'raw': {
                  // Raw chunks are only included if explicitly requested
                  if (includeRawChunks) {
                    // Raw chunks contain provider-specific data
                    // We don't have a direct mapping to UIMessageChunk
                    // but we can log or handle them if needed
                  }
                  break;
                }

                default: {
                  // Handle any other chunk types gracefully
                  // const exhaustiveCheck: never = partType;
                  // console.warn(`Unknown chunk type: ${partType}`);
                }
              }
            },
          })
        )
        .pipeThrough(
          // Optionally collect UIMessageChunks for later conversion to UIMessage[]
          new TransformStream<UIMessageChunk, UIMessageChunk>({
            transform: (chunk, controller) => {
              if (collectUIChunks) {
                uiChunks.push(chunk);
              }
              controller.enqueue(chunk);
            },
          })
        )
        .pipeTo(writable, { preventClose: true });

      // Materialize the reasoning aggregate in source order. Captured here
      // so we can both compute telemetry and ship it across the boundary.
      const reasoningParts: RawReasoningPart[] = reasoningOrder.map((id) => {
        const entry = reasoningById.get(id)!;
        return {
          text: entry.text,
          ...(entry.providerMetadata != null
            ? { providerMetadata: entry.providerMetadata }
            : {}),
        };
      });

      const reasoningTextForTelemetry = reasoningParts
        .map((r) => r.text)
        .join('');

      // ── Record response-time telemetry attributes on the span ──
      if (span) {
        const msToFinish = Date.now() - startTime;
        const finishReason = normalizeFinishReason(finish?.finishReason);

        // Usage attributes (not gated)
        const inputTokens = finish?.usage?.inputTokens?.total ?? 0;
        const outputTokens = finish?.usage?.outputTokens?.total ?? 0;
        const totalTokens = inputTokens + outputTokens;
        const reasoningTokens = finish?.usage?.outputTokens?.reasoning;
        const cachedInputTokens = finish?.usage?.inputTokens?.cacheRead;

        const responseAttrs: Record<string, unknown> = {
          // Response metadata
          'ai.response.finishReason': finishReason,
          'ai.response.id': responseMetadata?.id,
          'ai.response.model': responseMetadata?.modelId,
          ...(responseMetadata?.timestamp != null && {
            'ai.response.timestamp':
              responseMetadata.timestamp instanceof Date
                ? responseMetadata.timestamp.toISOString()
                : String(responseMetadata.timestamp),
          }),

          // Timing
          ...(msToFirstChunk !== undefined && {
            'ai.response.msToFirstChunk': msToFirstChunk,
          }),
          'ai.response.msToFinish': msToFinish,
          ...(outputTokens > 0 &&
            msToFinish > 0 && {
              'ai.response.avgOutputTokensPerSecond':
                (1000 * outputTokens) / msToFinish,
            }),

          // AI SDK usage attributes
          'ai.usage.inputTokens': inputTokens,
          'ai.usage.outputTokens': outputTokens,
          'ai.usage.totalTokens': totalTokens,
          ...(reasoningTokens != null && {
            'ai.usage.reasoningTokens': reasoningTokens,
          }),
          ...(cachedInputTokens != null && {
            'ai.usage.cachedInputTokens': cachedInputTokens,
          }),

          // gen_ai semantic convention response attributes
          'gen_ai.response.finish_reasons': [finishReason],
          ...(responseMetadata?.id != null && {
            'gen_ai.response.id': responseMetadata.id,
          }),
          ...(responseMetadata?.modelId != null && {
            'gen_ai.response.model': responseMetadata.modelId,
          }),
          'gen_ai.usage.input_tokens': inputTokens,
          'gen_ai.usage.output_tokens': outputTokens,
        };

        if (telemetry?.recordOutputs !== false) {
          if (textBuffer) {
            responseAttrs['ai.response.text'] = textBuffer;
          }
          if (reasoningTextForTelemetry) {
            responseAttrs['ai.response.reasoning'] = reasoningTextForTelemetry;
          }
          if (toolCalls.length > 0) {
            responseAttrs['ai.response.toolCalls'] = JSON.stringify(toolCalls);
          }
        }

        span.setAttributes(responseAttrs);
      }

      const raw: DoStreamStepRawResult = {
        text: textBuffer,
        reasoning: reasoningParts,
        files,
        sources,
        ...(warnings !== undefined ? { warnings } : {}),
        ...(responseMetadata !== undefined ? { responseMetadata } : {}),
        rawFinishReason: finish?.finishReason,
        ...(finish?.usage !== undefined ? { usage: finish.usage } : {}),
        ...(finish?.providerMetadata !== undefined
          ? { providerMetadata: finish.providerMetadata }
          : {}),
      };

      return {
        toolCalls,
        raw,
        uiChunks: collectUIChunks ? uiChunks : undefined,
        providerExecutedToolResults,
      };
    },
  });
}

/**
 * Normalize the finish reason to the AI SDK FinishReason type.
 * AI SDK v6 may return an object with a 'type' property,
 * while AI SDK v5 returns a plain string. This function handles both.
 *
 * @internal Exported for testing
 */
export function normalizeFinishReason(rawFinishReason: unknown): FinishReason {
  const KNOWN_FINISH_REASONS = new Set<string>([
    'stop',
    'length',
    'content-filter',
    'tool-calls',
    'error',
    'other',
  ]);

  // Handle object-style finish reason (V3 returns { unified, raw })
  if (typeof rawFinishReason === 'object' && rawFinishReason !== null) {
    const objReason = rawFinishReason as { unified?: string; type?: string };
    const extracted = objReason.unified ?? objReason.type ?? 'other';
    return (
      KNOWN_FINISH_REASONS.has(extracted) ? extracted : 'other'
    ) as FinishReason;
  }
  // Handle string finish reason (standard format)
  if (typeof rawFinishReason === 'string') {
    return rawFinishReason as FinishReason;
  }
  return 'other';
}
