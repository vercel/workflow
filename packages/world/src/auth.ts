import { z } from 'zod';

// Auth schemas
export const AuthInfoSchema = z.object({
  ownerId: z.string(),
  projectId: z.string(),
  environment: z.string(),
  userId: z.string().optional(),
});

export const HealthCheckResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      healthy: z.boolean(),
    })
    .and(z.record(z.string(), z.any())),
  message: z.string(),
});

// Inferred types
export type AuthInfo = z.infer<typeof AuthInfoSchema>;
export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;
