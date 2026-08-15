import type { Hook } from './hooks.js';

/** Caller-owned exact continuation receipt request. */
export interface CallerKeyedHookResumeRequest {
  idempotencyKey: string;
  semanticDigest: string;
  hook: Hook;
  eventData: unknown;
  queueName: string;
  queuePayload: unknown;
  queueOptions: unknown;
  resumePayloadDigest: string;
}

/** Canonical outcome of a caller-keyed continuation. */
export interface CallerKeyedHookResumeResult {
  inserted: boolean;
  semanticDigest: string;
  hook: Hook;
}

/** Backend-owned durable continuation receipt namespace. */
export interface HookResumes {
  get(request: {
    idempotencyKey: string;
    semanticDigest: string;
  }): Promise<CallerKeyedHookResumeResult | null>;
  resumeOrAdopt(
    request: CallerKeyedHookResumeRequest
  ): Promise<CallerKeyedHookResumeResult>;
  /** Drains committed-but-unacknowledged local receipts after restart. */
  drain?(): Promise<void>;
}
