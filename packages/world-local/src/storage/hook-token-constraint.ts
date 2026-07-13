import { z } from 'zod';
import { readJSON } from '../fs.js';

const HookTokenConstraintFields = {
  token: z.string(),
  runId: z.string(),
  hookId: z.string(),
  tokenExpiresAt: z.coerce.date().optional(),
};

const HookTokenConstraintSchema = z
  .union([
    z.object({
      ...HookTokenConstraintFields,
      type: z.literal('pinned'),
      eventId: z.string(),
    }),
    z.object({
      ...HookTokenConstraintFields,
      type: z.undefined().optional(),
      eventId: z.string().optional(),
    }),
  ])
  .transform((constraint) => {
    if (constraint.type === 'pinned') return constraint;
    const { eventId, ...legacy } = constraint;
    return eventId
      ? { ...legacy, type: 'pinned' as const, eventId }
      : { ...legacy, type: 'legacy' as const };
  });

export type HookTokenConstraint = z.infer<typeof HookTokenConstraintSchema>;

export async function readHookTokenConstraint(
  path: string
): Promise<HookTokenConstraint | null> {
  try {
    return await readJSON(path, HookTokenConstraintSchema);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return null;
    throw error;
  }
}

export function hasFutureTokenExpiration(
  constraint: Pick<HookTokenConstraint, 'tokenExpiresAt'>
): boolean {
  return (
    constraint.tokenExpiresAt !== undefined &&
    Date.now() < constraint.tokenExpiresAt.getTime()
  );
}
