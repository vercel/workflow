import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PaginatedResponseSchema } from './shared.js';

describe('PaginatedResponseSchema', () => {
  it('preserves optional analytics page metadata', () => {
    const result = PaginatedResponseSchema(z.object({ id: z.string() })).parse({
      data: [{ id: 'item_1' }],
      cursor: null,
      hasMore: false,
      pageInfo: {
        currentLookbackDays: 2,
        maxLookbackDays: 30,
        currentWindowStart: '2026-06-29T00:00:00.000Z',
        maxWindowStart: '2026-06-01T00:00:00.000Z',
        upgradeAvailable: true,
      },
    });

    expect(result.pageInfo).toEqual({
      currentLookbackDays: 2,
      maxLookbackDays: 30,
      currentWindowStart: new Date('2026-06-29T00:00:00.000Z'),
      maxWindowStart: new Date('2026-06-01T00:00:00.000Z'),
      upgradeAvailable: true,
    });
  });
});
