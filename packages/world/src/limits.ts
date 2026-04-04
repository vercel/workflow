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

const LimitConcurrencyOnlySchema = z.strictObject({
  concurrency: LimitConcurrencySchema,
  rate: z.undefined().optional(),
});

const LimitRateOnlySchema = z.strictObject({
  concurrency: z.undefined().optional(),
  rate: LimitRateSchema,
});

const LimitConcurrencyAndRateSchema = z.strictObject({
  concurrency: LimitConcurrencySchema,
  rate: LimitRateSchema,
});

export const LimitDefinitionSchema = z.union([
  LimitConcurrencyOnlySchema,
  LimitRateOnlySchema,
  LimitConcurrencyAndRateSchema,
]);
export type LimitDefinition = z.infer<typeof LimitDefinitionSchema>;

export const LimitLockIdSchema = z.string().min(1);
export type LimitLockId = z.infer<typeof LimitLockIdSchema>;

export function createLockId(runId: string, lockIndex: number): LimitLockId {
  return `${runId}:${lockIndex}`;
}

export function parseLockId(
  lockId: string
): { runId: string; lockIndex: number } | null {
  const separatorIndex = lockId.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex === lockId.length - 1) {
    return null;
  }

  const runId = lockId.slice(0, separatorIndex);
  const rawLockIndex = lockId.slice(separatorIndex + 1);
  const lockIndex = Number.parseInt(rawLockIndex, 10);
  if (!Number.isInteger(lockIndex) || lockIndex < 0) {
    return null;
  }

  return { runId, lockIndex };
}

export function parseLockCorrelationId(
  correlationId: string
): { runId: string; lockIndex: number } | null {
  if (!correlationId.startsWith('wflock_')) {
    return null;
  }

  return parseLockId(correlationId.slice('wflock_'.length));
}

export function createLockWakeCorrelationId(
  runId: string,
  lockIndex: number
): string {
  return `wflock_wait_${runId}:${lockIndex}`;
}

export function createLockCorrelationId(
  runId: string,
  lockIndex: number
): string {
  return `wflock_${runId}:${lockIndex}`;
}

export const LimitLeaseSchema = z.object({
  leaseId: z.string().min(1),
  key: LimitKeySchema,
  lockId: LimitLockIdSchema,
  runId: z.string().min(1),
  lockIndex: z.number().int().nonnegative(),
  acquiredAt: z.coerce.date(),
  expiresAt: z.coerce.date().optional(),
  definition: LimitDefinitionSchema,
});
export type LimitLease = z.infer<typeof LimitLeaseSchema>;

export const LimitAcquireRequestSchema = z.object({
  key: LimitKeySchema,
  runId: z.string().min(1),
  lockIndex: z.number().int().nonnegative(),
  definition: LimitDefinitionSchema,
  leaseTtlMs: z.number().int().positive().optional(),
});
export type LimitAcquireRequest = z.infer<typeof LimitAcquireRequestSchema>;

export const LimitBlockedReasonSchema = z.enum([
  'queued',
  'concurrency',
  'rate',
  'concurrency_and_rate',
]);
export type LimitBlockedReason = z.infer<typeof LimitBlockedReasonSchema>;

export function getBlockedReason(
  queuedBlocked: boolean,
  concurrencyBlocked: boolean,
  rateBlocked: boolean
): LimitBlockedReason {
  if (queuedBlocked) return 'queued';
  if (concurrencyBlocked && rateBlocked) return 'concurrency_and_rate';
  if (concurrencyBlocked) return 'concurrency';
  if (rateBlocked) return 'rate';

  throw new Error('Blocked reason requires a blocked state');
}

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

export function areLimitDefinitionsEqual(
  left: LimitDefinition,
  right: LimitDefinition
): boolean {
  return (
    left.concurrency?.max === right.concurrency?.max &&
    left.rate?.count === right.rate?.count &&
    left.rate?.periodMs === right.rate?.periodMs
  );
}

export const LimitReleaseRequestSchema = z.strictObject({
  leaseId: z.string().min(1),
  key: LimitKeySchema,
  lockId: LimitLockIdSchema,
});
export type LimitReleaseRequest = z.infer<typeof LimitReleaseRequestSchema>;

export const LimitNextWaiterSchema = z.object({
  runId: z.string().min(1),
  lockIndex: z.number().int().nonnegative(),
  wakeCorrelationId: z.string().min(1),
  lockCorrelationId: z.string().min(1),
});
export type LimitNextWaiter = z.infer<typeof LimitNextWaiterSchema>;

export const LimitPromotedWaiterSchema = LimitNextWaiterSchema.extend({
  leaseId: z.string().min(1),
  key: LimitKeySchema,
  lockId: LimitLockIdSchema,
});
export type LimitPromotedWaiter = z.infer<typeof LimitPromotedWaiterSchema>;

export const LimitReleaseResultSchema = z.object({
  promotedWaiters: z.array(LimitPromotedWaiterSchema),
});
export type LimitReleaseResult = z.infer<typeof LimitReleaseResultSchema>;

export const LimitHeartbeatRequestSchema = z.object({
  leaseId: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});
export type LimitHeartbeatRequest = z.infer<typeof LimitHeartbeatRequestSchema>;

export interface Limits {
  acquire(request: LimitAcquireRequest): Promise<LimitAcquireResult>;
  release(request: LimitReleaseRequest): Promise<LimitReleaseResult>;
  heartbeat(request: LimitHeartbeatRequest): Promise<LimitLease>;
}
