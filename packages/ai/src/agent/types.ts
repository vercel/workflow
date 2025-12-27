/**
 * Shared types for AI SDK v5 and v6 compatibility.
 */
import type {
  LanguageModelV2,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';

/**
 * Compatible language model type that works with both AI SDK v5 and v6.
 *
 * AI SDK v5 uses LanguageModelV2, while AI SDK v6 uses LanguageModelV3.
 * Both have compatible `doStream` interfaces for our use case.
 *
 * This type represents the union of both model versions, allowing code
 * to work seamlessly with either AI SDK version.
 *
 * Note: The `doStream` method accepts `any` for the options parameter to
 * handle the minor type differences between V2 and V3 call options.
 * At runtime, the prompt and options structures are compatible.
 */
export type CompatibleLanguageModel =
  | LanguageModelV2
  | {
      readonly specificationVersion: 'v3';
      readonly provider: string;
      readonly modelId: string;
      // Using 'any' for options since V2 and V3 call options are structurally
      // compatible at runtime but have different type names
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doStream(options: any): PromiseLike<{
        stream: ReadableStream<LanguageModelV2StreamPart>;
      }>;
    };
