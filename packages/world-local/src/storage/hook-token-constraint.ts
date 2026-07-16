import path from 'node:path';
import { z } from 'zod';
import { readJSON } from '../fs.js';
import { hashToken } from './helpers.js';

/** Path of the file that reserves a Hook token across processes. */
export function hookTokenConstraintPath(
  basedir: string,
  token: string
): string {
  return path.join(basedir, 'hooks', 'tokens', `${hashToken(token)}.json`);
}

const HookTokenConstraintFields = {
  token: z.string(),
  runId: z.string(),
  hookId: z.string(),
  tokenRetentionUntil: z.coerce.date().optional(),
};

// Normalize pre-retention constraints so migration states remain explicit.
const HookTokenConstraintSchema = z.union([
  z.object({
    ...HookTokenConstraintFields,
    type: z.literal('current'),
    tag: z.string().nullable(),
    eventId: z.string(),
  }),
  z
    .object({
      ...HookTokenConstraintFields,
      eventId: z.string().optional(),
    })
    .transform(({ eventId, ...constraint }) =>
      eventId
        ? { ...constraint, type: 'legacy-pinned' as const, eventId }
        : { ...constraint, type: 'legacy' as const }
    ),
]);

export type HookTokenConstraint = z.infer<typeof HookTokenConstraintSchema>;
export type CurrentHookTokenConstraint = Extract<
  HookTokenConstraint,
  { type: 'current' }
>;

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

export function hasRemainingTokenRetention(
  constraint: Pick<HookTokenConstraint, 'tokenRetentionUntil'>
): boolean {
  return (
    constraint.tokenRetentionUntil !== undefined &&
    Date.now() < constraint.tokenRetentionUntil.getTime()
  );
}
