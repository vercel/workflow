import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z, ZodError } from 'zod';
import { defineHook } from './define-hook.js';
import { resumeHook } from './runtime/resume-hook.js';

vi.mock('./runtime/resume-hook.js', () => ({
  resumeHook: vi.fn(),
}));

const resumeHookMock = vi.mocked(resumeHook);

describe('defineHook', () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
  });

  it('returns a defined hook without schema', async () => {
    resumeHookMock.mockResolvedValueOnce(null);
    const hook = defineHook<{ value: number }>();

    expect(hook.schema).toBeUndefined();

    const payload = { value: 42 };
    await expect(hook.resume('token-123', payload)).resolves.toBeNull();

    expect(resumeHookMock).toHaveBeenCalledWith('token-123', payload);
    expect(() => hook.create()).toThrowError(
      '`defineHook().create()` can only be called inside a workflow function.'
    );
  });

  it('validates payloads using the provided schema', async () => {
    resumeHookMock.mockResolvedValueOnce({} as any);

    const schema = z
      .object({
        memberId: z.uuid(),
        role: z.enum(['viewer', 'editor']),
      })
      .transform(({ memberId, role }) => ({
        id: memberId,
        permissions: role === 'editor' ? ['read', 'write'] : ['read'],
      }));
    const hook = defineHook(schema);

    expect(hook.schema).toBe(schema);

    const payload = {
      memberId: '11111111-1111-4111-8111-111111111111',
      role: 'viewer' as const,
    };

    await hook.resume('token-456', payload);
    expect(resumeHookMock).toHaveBeenCalledWith('token-456', {
      id: '11111111-1111-4111-8111-111111111111',
      permissions: ['read'],
    });
  });

  it('throws when payload does not satisfy the schema', () => {
    const schema = z.object({
      memberId: z.uuid(),
      role: z.enum(['viewer', 'editor']),
    });
    const hook = defineHook(schema);

    expect(() =>
      hook.resume('token-789', {
        memberId: 'not-a-uuid',
        role: 'viewer',
      })
    ).toThrow(ZodError);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });
});
