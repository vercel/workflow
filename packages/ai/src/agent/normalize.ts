import type { JSONObject } from '@ai-sdk/provider';
import type { FinishReason } from 'ai';

/**
 * Result of normalizing a finish reason, containing both the unified reason
 * and the optional raw provider string (V3 only).
 *
 * @internal
 */
export interface NormalizedFinishReason {
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
}

/**
 * Normalize finish reason from V2 (string) or V3 ({unified, raw}) format.
 * Returns both the unified finish reason and the raw provider string.
 *
 * @internal
 */
export function normalizeFinishReason(raw: unknown): NormalizedFinishReason {
  if (raw == null)
    return { finishReason: 'unknown', rawFinishReason: undefined };
  if (typeof raw === 'string') {
    const finishReason = (raw === '' ? 'unknown' : raw) as FinishReason;
    return { finishReason, rawFinishReason: raw || undefined };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const rawValue = typeof obj.raw === 'string' ? obj.raw : undefined;
    // V3: { unified: 'stop', raw: 'stop' }
    if (typeof obj.unified === 'string') {
      return {
        finishReason: obj.unified as FinishReason,
        rawFinishReason: rawValue,
      };
    }
    // V2 object fallback: { type: 'stop' }
    if (typeof obj.type === 'string') {
      return {
        finishReason: obj.type as FinishReason,
        rawFinishReason: rawValue,
      };
    }
  }
  return { finishReason: 'unknown', rawFinishReason: undefined };
}

/**
 * Normalized usage type that is a superset of both v5 (LanguageModelV2Usage)
 * and v6 (LanguageModelUsage). V5 consumers see the flat fields they expect;
 * v6 consumers see the detailed breakdowns and raw data.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokenDetails: {
    noCacheTokens: number | undefined;
    cacheReadTokens: number | undefined;
    cacheWriteTokens: number | undefined;
  };
  outputTokenDetails: {
    textTokens: number | undefined;
    reasoningTokens: number | undefined;
  };
  raw?: JSONObject;
}

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokenDetails: {
    textTokens: undefined,
    reasoningTokens: undefined,
  },
};

/**
 * Normalize usage from V2 (flat) or V3 (nested) format into a shape
 * compatible with both v5 and v6 StepResult.usage.
 *
 * V5 (LanguageModelV2Usage): { inputTokens, outputTokens, totalTokens }
 * V6 (LanguageModelUsage): adds inputTokenDetails, outputTokenDetails, raw
 *
 * The returned object includes all fields. V5 consumers ignore the extras.
 *
 * @internal
 */
export function normalizeUsage(raw: unknown): NormalizedUsage {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_USAGE };
  }

  const obj = raw as Record<string, unknown>;

  // V2 format: flat numbers (may include deprecated cachedInputTokens/reasoningTokens)
  if (typeof obj.inputTokens === 'number') {
    const inputTokens = obj.inputTokens;
    const outputTokens = (obj.outputTokens as number) ?? 0;
    const totalTokens =
      (obj.totalTokens as number) ?? inputTokens + outputTokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: (obj.cachedInputTokens as number) ?? undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: (obj.reasoningTokens as number) ?? undefined,
      },
      ...(obj.raw != null ? { raw: obj.raw as JSONObject } : {}),
    };
  }

  // V3 format: nested objects with .total and detailed breakdowns
  if (
    typeof obj.inputTokens === 'object' ||
    typeof obj.outputTokens === 'object'
  ) {
    const inputObj = obj.inputTokens as Record<string, unknown> | undefined;
    const outputObj = obj.outputTokens as Record<string, unknown> | undefined;
    const inputTokens = (inputObj?.total as number) ?? 0;
    const outputTokens = (outputObj?.total as number) ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      inputTokenDetails: {
        noCacheTokens: (inputObj?.noCache as number) ?? undefined,
        cacheReadTokens: (inputObj?.cacheRead as number) ?? undefined,
        cacheWriteTokens: (inputObj?.cacheWrite as number) ?? undefined,
      },
      outputTokenDetails: {
        textTokens: (outputObj?.text as number) ?? undefined,
        reasoningTokens: (outputObj?.reasoning as number) ?? undefined,
      },
      ...(obj.raw != null ? { raw: obj.raw as JSONObject } : {}),
    };
  }

  return { ...EMPTY_USAGE };
}

/**
 * Add two NormalizedUsage objects together, summing all token counts.
 *
 * @internal
 */
export function addUsage(
  a: NormalizedUsage,
  b: NormalizedUsage
): NormalizedUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokenDetails: {
      noCacheTokens: addOptional(
        a.inputTokenDetails.noCacheTokens,
        b.inputTokenDetails.noCacheTokens
      ),
      cacheReadTokens: addOptional(
        a.inputTokenDetails.cacheReadTokens,
        b.inputTokenDetails.cacheReadTokens
      ),
      cacheWriteTokens: addOptional(
        a.inputTokenDetails.cacheWriteTokens,
        b.inputTokenDetails.cacheWriteTokens
      ),
    },
    outputTokenDetails: {
      textTokens: addOptional(
        a.outputTokenDetails.textTokens,
        b.outputTokenDetails.textTokens
      ),
      reasoningTokens: addOptional(
        a.outputTokenDetails.reasoningTokens,
        b.outputTokenDetails.reasoningTokens
      ),
    },
  };
}

function addOptional(
  a: number | undefined,
  b: number | undefined
): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}
