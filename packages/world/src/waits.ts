import { z } from 'zod';

export const WaitStatusSchema = z.enum(['waiting', 'completed']);

export const WaitSchema = z.object({
  waitId: z.string(),
  runId: z.string(),
  status: WaitStatusSchema,
  resumeAt: z.coerce.date().optional(),
  completedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  specVersion: z.number().optional(),
});

export type WaitStatus = z.infer<typeof WaitStatusSchema>;
export type Wait = z.infer<typeof WaitSchema>;
