import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError, z } from 'zod';
import { defineHook } from './define-hook.js';

vi.mock('./runtime/resume-hook.js', () => ({
  resumeHook: vi.fn(),
}));

const { resumeHook } = await import('./runtime/resume-hook.js');
const resumeHookMock = vi.mocked(resumeHook);

describe('defineHook', () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
  });

  it('passes payload through when no schema is provided', async () => {
    const hook = defineHook<{ approved: boolean; comment: string }>();

    resumeHookMock.mockResolvedValue(null);

    const payload = { approved: true, comment: 'Looks good' };
    await hook.resume('token', payload);

    expect(resumeHookMock).toHaveBeenCalledWith('token', payload);
  });

  it('parses payload with schema before resuming', async () => {
    const hook = defineHook({
      schema: z.object({
        approved: z.boolean(),
        comment: z.string().transform((value) => value.trim()),
      }),
    });

    resumeHookMock.mockResolvedValue(null);

    await hook.resume('token', { approved: true, comment: '  Ready!  ' });

    expect(resumeHookMock).toHaveBeenCalledWith('token', {
      approved: true,
      comment: 'Ready!',
    });
  });

  it('throws when schema validation fails', () => {
    const hook = defineHook({
      schema: z.object({
        approved: z.boolean(),
        comment: z.string(),
      }),
    });

    expect(() =>
      hook.resume('token', { approved: 'yes', comment: 123 } as unknown as {
        approved: boolean;
        comment: string;
      })
    ).toThrowError(ZodError);
  });
});
