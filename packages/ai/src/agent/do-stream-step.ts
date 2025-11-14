import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolCall,
} from '@ai-sdk/provider';
import { gateway, type UIMessageChunk } from 'ai';

type FinishPart = Extract<LanguageModelV2StreamPart, { type: 'finish' }>;

export async function doStreamStep(
  conversationPrompt: LanguageModelV2Prompt,
  modelInit: string | (() => Promise<LanguageModelV2>),
  writable: WritableStream<UIMessageChunk>,
  tools?: LanguageModelV2CallOptions['tools']
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
          controller.enqueue(chunk);
        },
      })
    )
    .pipeThrough(
      new TransformStream<LanguageModelV2StreamPart, UIMessageChunk>({
        start: (controller) => {
          controller.enqueue({
            type: 'start',
          });
          controller.enqueue({
            type: 'start-step',
          });
        },
        flush: (controller) => {
          controller.enqueue({
            type: 'finish-step',
          });
          controller.enqueue({
            type: 'finish',
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

            // case "error": {
            //   controller.enqueue({
            //     type: "error",
            //     errorText: onError(part.error),
            //   });
            //   break;
            // }

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

  return { toolCalls, finish };
}
