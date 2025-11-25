import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolCall,
} from '@ai-sdk/provider';
import {
  gateway,
  type StepResult,
  type StopCondition,
  type ToolSet,
  type UIMessageChunk,
} from 'ai';

export type FinishPart = Extract<LanguageModelV2StreamPart, { type: 'finish' }>;

export type ModelStopCondition = StopCondition<NoInfer<ToolSet>>;

export async function doStreamStep(
  conversationPrompt: LanguageModelV2Prompt,
  modelInit: string | (() => Promise<LanguageModelV2>),
  writable: WritableStream<UIMessageChunk>,
  tools?: LanguageModelV2CallOptions['tools'],
  options?: {
    sendStart?: boolean;
  }
) {
  'use step';

  let model: LanguageModelV2 | undefined;
  if (typeof modelInit === 'string') {
    model = gateway(modelInit);
  } else if (typeof modelInit === 'function') {
    model = await modelInit();
  } else {
    throw new Error(
      'Invalid "model initialization" argument. Must be a string or a function that returns a LanguageModelV2 instance.'
    );
  }

  const result = await model.doStream({
    prompt: conversationPrompt,
    tools,
  });

  let finish: FinishPart | undefined;
  const toolCalls: LanguageModelV2ToolCall[] = [];
  const chunks: LanguageModelV2StreamPart[] = [];

  await result.stream
    .pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (chunk.type === 'tool-call') {
            toolCalls.push({
              ...chunk,
              input: chunk.input || '{}',
            });
          } else if (chunk.type === 'finish') {
            finish = chunk;
          }
          chunks.push(chunk);
          controller.enqueue(chunk);
        },
      })
    )
    .pipeThrough(
      new TransformStream<LanguageModelV2StreamPart, UIMessageChunk>({
        start: (controller) => {
          if (options?.sendStart) {
            controller.enqueue({
              type: 'start',
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

            // case "file": {
            //   controller.enqueue({
            //     type: "file",
            //     mediaType: part.file.mediaType,
            //     url: `data:${part.file.mediaType};base64,${part.file.base64}`,
            //   });
            //   break;
            // }

            // case "source": {
            //   if (sendSources && part.sourceType === "url") {
            //     controller.enqueue({
            //       type: "source-url",
            //       sourceId: part.id,
            //       url: part.url,
            //       title: part.title,
            //       ...(part.providerMetadata != null
            //         ? { providerMetadata: part.providerMetadata }
            //         : {}),
            //     });
            //   }

            //   if (sendSources && part.sourceType === "document") {
            //     controller.enqueue({
            //       type: "source-document",
            //       sourceId: part.id,
            //       mediaType: part.mediaType,
            //       title: part.title,
            //       filename: part.filename,
            //       ...(part.providerMetadata != null
            //         ? { providerMetadata: part.providerMetadata }
            //         : {}),
            //     });
            //   }
            //   break;
            // }

            // case "tool-input-start": {
            //   const dynamic = isDynamic(part);

            //   controller.enqueue({
            //     type: "tool-input-start",
            //     toolCallId: part.id,
            //     toolName: part.toolName,
            //     ...(part.providerExecuted != null
            //       ? { providerExecuted: part.providerExecuted }
            //       : {}),
            //     ...(dynamic != null ? { dynamic } : {}),
            //   });
            //   break;
            // }

            // case "tool-input-delta": {
            //   controller.enqueue({
            //     type: "tool-input-delta",
            //     toolCallId: part.id,
            //     inputTextDelta: part.delta,
            //   });
            //   break;
            // }

            case 'tool-call': {
              // const dynamic = isDynamic(part);

              // if (part.invalid) {
              //   controller.enqueue({
              //     type: "tool-input-error",
              //     toolCallId: part.toolCallId,
              //     toolName: part.toolName,
              //     input: part.input,
              //     ...(part.providerExecuted != null
              //       ? { providerExecuted: part.providerExecuted }
              //       : {}),
              //     ...(part.providerMetadata != null
              //       ? { providerMetadata: part.providerMetadata }
              //       : {}),
              //     ...(dynamic != null ? { dynamic } : {}),
              //     errorText: onError(part.error),
              //   });
              // } else {
              controller.enqueue({
                type: 'tool-input-available',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: JSON.parse(part.input || '{}'),
                ...(part.providerExecuted != null
                  ? { providerExecuted: part.providerExecuted }
                  : {}),
                ...(part.providerMetadata != null
                  ? { providerMetadata: part.providerMetadata }
                  : {}),
                // ...(dynamic != null ? { dynamic } : {}),
              });
              // }
              break;
            }

            // case "tool-approval-request": {
            //   controller.enqueue({
            //     type: "tool-approval-request",
            //     approvalId: part.approvalId,
            //     toolCallId: part.toolCall.toolCallId,
            //   });
            //   break;
            // }

            // case "tool-result": {
            //   const dynamic = isDynamic(part);

            //   controller.enqueue({
            //     type: "tool-output-available",
            //     toolCallId: part.toolCallId,
            //     output: part.output,
            //     ...(part.providerExecuted != null
            //       ? { providerExecuted: part.providerExecuted }
            //       : {}),
            //     ...(part.preliminary != null
            //       ? { preliminary: part.preliminary }
            //       : {}),
            //     ...(dynamic != null ? { dynamic } : {}),
            //   });
            //   break;
            // }

            // case "tool-error": {
            //   const dynamic = isDynamic(part);

            //   controller.enqueue({
            //     type: "tool-output-error",
            //     toolCallId: part.toolCallId,
            //     errorText: onError(part.error),
            //     ...(part.providerExecuted != null
            //       ? { providerExecuted: part.providerExecuted }
            //       : {}),
            //     ...(dynamic != null ? { dynamic } : {}),
            //   });
            //   break;
            // }

            // case "tool-output-denied": {
            //   controller.enqueue({
            //     type: "tool-output-denied",
            //     toolCallId: part.toolCallId,
            //   });
            //   break;
            // }

            case 'error': {
              const error = part.error;
              controller.enqueue({
                type: 'error',
                errorText:
                  error instanceof Error ? error.message : String(error),
              });

              break;
            }

            // case "start-step": {
            //   controller.enqueue({ type: "start-step" });
            //   break;
            // }

            // case "finish-step": {
            //   controller.enqueue({ type: "finish-step" });
            //   break;
            // }

            // case "start": {
            //   if (sendStart) {
            //     controller.enqueue({
            //       type: "start",
            //       ...(messageMetadataValue != null
            //         ? { messageMetadata: messageMetadataValue }
            //         : {}),
            //       ...(responseMessageId != null
            //         ? { messageId: responseMessageId }
            //         : {}),
            //     });
            //   }
            //   break;
            // }

            // case "finish": {
            //   if (sendFinish) {
            //     controller.enqueue({
            //       type: "finish",
            //       ...(messageMetadataValue != null
            //         ? { messageMetadata: messageMetadataValue }
            //         : {}),
            //     });
            //   }
            //   break;
            // }

            // case "abort": {
            //   controller.enqueue(part);
            //   break;
            // }

            // case "tool-input-end": {
            //   break;
            // }

            // case "raw": {
            //   // Raw chunks are not included in UI message streams
            //   // as they contain provider-specific data for developer use
            //   break;
            // }

            // default: {
            //   const exhaustiveCheck: never = partType;
            //   throw new Error(`Unknown chunk type: ${exhaustiveCheck}`);
            // }
          }
        },
      })
    )
    .pipeTo(writable, { preventClose: true });

  // if (!finish) {
  //   // This will cause the step to be retried
  //   throw new Error('LLM stream ended without a "finish" chunk');
  // }

  const step = chunksToStep(chunks, toolCalls, conversationPrompt, finish);
  return { toolCalls, finish, step };
}

// This is a stand-in for logic in the AI-SDK streamText code which aggregates
// chunks into a single step result.
function chunksToStep(
  chunks: LanguageModelV2StreamPart[],
  toolCalls: LanguageModelV2ToolCall[],
  conversationPrompt: LanguageModelV2Prompt,
  finish?: FinishPart
): StepResult<any> {
  // Transform chunks to a single step result
  const text = chunks
    .filter(
      (chunk): chunk is Extract<typeof chunk, { type: 'text-delta' }> =>
        chunk.type === 'text-delta'
    )
    .map((chunk) => chunk.delta)
    .join('');

  const reasoning = chunks.filter(
    (chunk): chunk is Extract<typeof chunk, { type: 'reasoning-delta' }> =>
      chunk.type === 'reasoning-delta'
  );

  const reasoningText = reasoning.map((chunk) => chunk.delta).join('');

  // Extract warnings from stream-start chunk
  const streamStart = chunks.find(
    (chunk): chunk is Extract<typeof chunk, { type: 'stream-start' }> =>
      chunk.type === 'stream-start'
  );

  // Extract response metadata from response-metadata chunk
  const responseMetadata = chunks.find(
    (chunk): chunk is Extract<typeof chunk, { type: 'response-metadata' }> =>
      chunk.type === 'response-metadata'
  );

  const stepResult: StepResult<any> = {
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((toolCall) => ({
        type: 'tool-call' as const,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: JSON.parse(toolCall.input),
        dynamic: true as const,
      })),
    ],
    text,
    reasoning: reasoning.map((chunk) => ({
      type: 'reasoning' as const,
      text: chunk.delta,
    })),
    reasoningText: reasoningText || undefined,
    files: [],
    sources: [],
    toolCalls: toolCalls.map((toolCall) => ({
      type: 'tool-call' as const,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: JSON.parse(toolCall.input),
      dynamic: true as const,
    })),
    staticToolCalls: [],
    dynamicToolCalls: toolCalls.map((toolCall) => ({
      type: 'tool-call' as const,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: JSON.parse(toolCall.input),
      dynamic: true as const,
    })),
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: finish?.finishReason || 'unknown',
    usage: finish?.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    warnings: streamStart?.warnings,
    request: {
      body: JSON.stringify({
        prompt: conversationPrompt,
        tools: toolCalls.map((toolCall) => ({
          type: 'tool-call' as const,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: JSON.parse(toolCall.input),
          dynamic: true as const,
        })),
      }),
    },
    response: {
      id: responseMetadata?.id ?? 'unknown',
      timestamp: responseMetadata?.timestamp ?? new Date(),
      modelId: responseMetadata?.modelId ?? 'unknown',
      messages: [],
    },
    providerMetadata: finish?.providerMetadata || {},
  };

  return stepResult;
}
