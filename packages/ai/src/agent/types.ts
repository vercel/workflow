/**
 * Shared types for AI SDK v5 and v6 compatibility.
 */
import type { LanguageModelV2 } from '@ai-sdk/provider';

/**
 * Compatible language model type that works with both AI SDK v5 and v6.
 *
 * AI SDK v5 uses LanguageModelV2, while AI SDK v6 uses LanguageModelV3.
 * DurableAgent converts model objects to `"provider/modelId"` strings for
 * step boundary serialization (see {@link resolveModelId}), so only the
 * identity properties are required from V3 models.
 *
 * The V3 branch intentionally omits `doStream` because the V2 and V3
 * signatures are structurally incompatible at the TypeScript level
 * (different CallOptions, StreamPart, FinishReason, and Usage shapes).
 * Runtime V2/V3 differences are handled by {@link normalizeFinishReason}
 * and {@link normalizeUsage} in normalize.ts.
 */
export type CompatibleLanguageModel =
  | LanguageModelV2
  | {
      readonly specificationVersion: 'v3';
      readonly provider: string;
      readonly modelId: string;
    };

// ---------------------------------------------------------------------------
// V3 stream part extensions
//
// These interfaces centralize duck-typing assumptions for AI SDK v6
// properties that don't exist in the installed @ai-sdk/provider V2 type
// definitions. When @ai-sdk/provider ships V3 types, replace these with
// the canonical imports and remove the casts in do-stream-step.ts.
// ---------------------------------------------------------------------------

/** @internal V3 adds a `preliminary` flag to tool-result stream parts. */
export interface V3ToolResultExtension {
  preliminary?: boolean;
}

/** @internal V3 adds `title` and `dynamic` to tool-input-start stream parts. */
export interface V3ToolInputStartExtension {
  title?: string;
  dynamic?: boolean;
}

/** @internal V3 adds a `dynamic` flag to tool calls. */
export interface V3ToolCallExtension {
  dynamic?: boolean;
}

/** @internal V3 doStream result includes request metadata for telemetry. */
export interface V3DoStreamRequestMetadata {
  body?: unknown;
}
