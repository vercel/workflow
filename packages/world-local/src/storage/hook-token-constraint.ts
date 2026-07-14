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
  tokenExpiresAt: z.coerce.date().optional(),
};

// Current files include both the canonical event and owner tag. Normalize
// older shapes at this boundary so callers handle migration states explicitly.
const HookTokenConstraintSchema = z
  .union([
    z.object({
      ...HookTokenConstraintFields,
      type: z.enum(['current', 'pinned']),
      tag: z.string().nullable().optional(),
      eventId: z.string(),
    }),
    z.object({
      ...HookTokenConstraintFields,
      type: z.undefined().optional(),
      tag: z.string().nullable().optional(),
      eventId: z.string().optional(),
    }),
  ])
  .transform((constraint) => {
    const { eventId, tag, type: _storedType, ...fields } = constraint;
    if (eventId && tag !== undefined) {
      return { ...fields, type: 'current' as const, eventId, tag };
    }
    if (eventId) {
      return { ...fields, type: 'legacy-pinned' as const, eventId };
    }
    return { ...fields, type: 'legacy' as const };
  });

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

export function hasFutureTokenExpiration(
  constraint: Pick<HookTokenConstraint, 'tokenExpiresAt'>
): boolean {
  return (
    constraint.tokenExpiresAt !== undefined &&
    Date.now() < constraint.tokenExpiresAt.getTime()
  );
}
