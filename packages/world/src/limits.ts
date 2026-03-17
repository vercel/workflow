import { z } from 'zod';

export const LIMITS_NOT_IMPLEMENTED_MESSAGE =
  'Flow limits are reserved for future support and are not implemented yet.';

export function createLimitsNotImplementedError(): Error {
  return new Error(LIMITS_NOT_IMPLEMENTED_MESSAGE);
}

export const LimitKeySchema = z.string().min(1);
export type LimitKey = z.infer<typeof LimitKeySchema>;

export const LimitConcurrencySchema = z.object({
  max: z.number().int().positive(),
});
export type LimitConcurrency = z.infer<typeof LimitConcurrencySchema>;

export const LimitRateSchema = z.object({
  count: z.number().int().positive(),
  periodMs: z.number().int().positive(),
});
export type LimitRate = z.infer<typeof LimitRateSchema>;

export const LimitDefinitionSchema = z
  .object({
    concurrency: LimitConcurrencySchema.optional(),
    rate: LimitRateSchema.optional(),
  })
  .refine(
    (value) => value.concurrency !== undefined || value.rate !== undefined,
    {
      message: 'At least one limit must be configured',
    }
  );
export type LimitDefinition = z.infer<typeof LimitDefinitionSchema>;

export const LimitLeaseSchema = z.object({
  leaseId: z.string().min(1),
  key: LimitKeySchema,
  holderId: z.string().min(1),
  acquiredAt: z.coerce.date(),
  expiresAt: z.coerce.date().optional(),
  definition: LimitDefinitionSchema,
});
export type LimitLease = z.infer<typeof LimitLeaseSchema>;

export const LimitAcquireRequestSchema = z.object({
  key: LimitKeySchema,
  holderId: z.string().min(1),
  definition: LimitDefinitionSchema,
  leaseTtlMs: z.number().int().positive().optional(),
});
export type LimitAcquireRequest = z.infer<typeof LimitAcquireRequestSchema>;

export const LimitBlockedReasonSchema = z.enum([
  'concurrency',
  'rate',
  'concurrency_and_rate',
]);
export type LimitBlockedReason = z.infer<typeof LimitBlockedReasonSchema>;

export const LimitAcquireStatusSchema = z.enum(['acquired', 'blocked']);
export type LimitAcquireStatus = z.infer<typeof LimitAcquireStatusSchema>;

export const LimitAcquireAcquiredResultSchema = z.object({
  status: z.literal(LimitAcquireStatusSchema.enum.acquired),
  lease: LimitLeaseSchema,
});
export type LimitAcquireAcquiredResult = z.infer<
  typeof LimitAcquireAcquiredResultSchema
>;

export const LimitAcquireBlockedResultSchema = z.object({
  status: z.literal(LimitAcquireStatusSchema.enum.blocked),
  reason: LimitBlockedReasonSchema,
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type LimitAcquireBlockedResult = z.infer<
  typeof LimitAcquireBlockedResultSchema
>;

export const LimitAcquireResultSchema = z.discriminatedUnion('status', [
  LimitAcquireAcquiredResultSchema,
  LimitAcquireBlockedResultSchema,
]);
export type LimitAcquireResult = z.infer<typeof LimitAcquireResultSchema>;

export const LimitReleaseRequestSchema = z.object({
  leaseId: z.string().min(1),
  key: LimitKeySchema.optional(),
  holderId: z.string().min(1).optional(),
});
export type LimitReleaseRequest = z.infer<typeof LimitReleaseRequestSchema>;

export const LimitHeartbeatRequestSchema = z.object({
  leaseId: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});
export type LimitHeartbeatRequest = z.infer<typeof LimitHeartbeatRequestSchema>;

export interface Limits {
  acquire(request: LimitAcquireRequest): Promise<LimitAcquireResult>;
  release(request: LimitReleaseRequest): Promise<void>;
  heartbeat(request: LimitHeartbeatRequest): Promise<LimitLease>;
}
