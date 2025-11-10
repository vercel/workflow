import type { StandardSchemaV1 } from '@standard-schema/spec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineHook } from './define-hook.js';

vi.mock('./runtime/resume-hook.js', () => ({
  resumeHook: vi.fn(),
}));

const { resumeHook } = await import('./runtime/resume-hook.js');
const resumeHookMock = vi.mocked(resumeHook);

const approvalSchema: StandardSchemaV1<
  { approved: boolean; comment: string },
  { approved: boolean; comment: string }
> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (typeof value !== 'object' || value === null) {
        return {
          issues: [{ message: 'Invalid payload: expected object' }],
        };
      }

      const input = value as {
        approved: unknown;
        comment: unknown;
      };
      const issues: StandardSchemaV1.Issue[] = [];

      if (typeof input.approved !== 'boolean') {
        issues.push({
          message: 'Invalid input: expected boolean at "approved"',
        });
      }

      if (typeof input.comment !== 'string') {
        issues.push({ message: 'Invalid input: expected string at "comment"' });
      }

      if (issues.length > 0) {
        return { issues };
      }

      return {
        value: {
          approved: input.approved as boolean,
          comment: (input.comment as string).trim(),
        },
      };
    },
  },
};

describe('defineHook', () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
  });

  it('passes payload through when no schema is provided', async () => {
    const hook = defineHook<{ approved: boolean; comment: string }>();

    resumeHookMock.mockResolvedValue({
      hookId: 'hook-id',
      token: 'token',
      runId: 'run-id',
    });

    const payload = { approved: true, comment: 'Looks good' };
    await hook.resume('token', payload);

    expect(resumeHookMock).toHaveBeenCalledWith('token', payload);
  });

  it('parses payload with schema before resuming', async () => {
    const hook = defineHook({ schema: approvalSchema });

    resumeHookMock.mockResolvedValue({
      hookId: 'hook-id',
      token: 'token',
      runId: 'run-id',
    });

    await hook.resume('token', { approved: true, comment: '  Ready!  ' });

    expect(resumeHookMock).toHaveBeenCalledWith('token', {
      approved: true,
      comment: 'Ready!',
    });
  });

  it('throws when schema validation fails', async () => {
    const hook = defineHook({ schema: approvalSchema });

    await expect(
      hook.resume('token', {
        approved: 'yes',
        comment: 123,
      } as unknown as {
        approved: boolean;
        comment: string;
      })
    ).rejects.toThrowErrorMatchingInlineSnapshot(`
      [Error: [
        {
          "message": "Invalid input: expected boolean at \\"approved\\""
        },
        {
          "message": "Invalid input: expected string at \\"comment\\""
        }
      ]]
    `);
  });
});
