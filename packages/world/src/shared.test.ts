import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PageInfoSchema, PaginatedResponseSchema } from './shared.js';

function uncompiledPage(dataSchema: z.ZodTypeAny) {
  return z.object({
    data: z.array(dataSchema),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
    pageInfo: PageInfoSchema.optional(),
  });
}

function countGeneratedFunctions(run: () => void): number {
  const original = globalThis.Function;
  let calls = 0;
  globalThis.Function = new Proxy(original, {
    construct(target, args, newTarget) {
      calls += 1;
      return Reflect.construct(target, args, newTarget);
    },
  }) as unknown as FunctionConstructor;
  try {
    run();
    return calls;
  } finally {
    globalThis.Function = original;
  }
}

describe('PaginatedResponseSchema', () => {
  const page = {
    data: [{ id: 'item_1' }],
    cursor: 'next',
    hasMore: true,
  };

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

  it('reuses the compiled schema for the same data schema object', () => {
    const dataSchema = z.object({ id: z.string() });
    const first = PaginatedResponseSchema(dataSchema);
    const second = PaginatedResponseSchema(dataSchema);

    expect(second).toBe(first);
    expect(first.parse(page)).toEqual(page);
    expect(second.parse(page)).toEqual(page);
  });

  it('keeps different data schema objects separate', () => {
    const first = PaginatedResponseSchema(z.object({ id: z.string() }));
    const second = PaginatedResponseSchema(z.object({ id: z.string() }));

    expect(second).not.toBe(first);
    expect(first.parse(page)).toEqual(page);
    expect(second.parse(page)).toEqual(page);
  });

  it('compiles a data schema once', () => {
    const dataSchema = z.object({ id: z.string() });
    const first = countGeneratedFunctions(() => {
      PaginatedResponseSchema(dataSchema);
    });
    const second = countGeneratedFunctions(() => {
      PaginatedResponseSchema(dataSchema);
    });

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('reports the same Zod issues as the uncompiled schema', () => {
    const dataSchema = z.object({ id: z.string() });
    const compiled = PaginatedResponseSchema(dataSchema);
    const baseline = uncompiledPage(dataSchema);
    const invalid = [
      { data: [{ id: 1 }], cursor: null, hasMore: false },
      { data: [], cursor: 1, hasMore: false },
      { data: [], cursor: null, hasMore: 'yes' },
    ];

    for (const body of invalid) {
      const compiledResult = compiled.safeParse(body);
      const baselineResult = baseline.safeParse(body);
      expect(compiledResult.success).toBe(false);
      expect(baselineResult.success).toBe(false);
      if (!compiledResult.success && !baselineResult.success) {
        expect(compiledResult.error.issues).toEqual(
          baselineResult.error.issues
        );
      }
    }

    const again = compiled.safeParse(invalid[0]);
    const first = compiled.safeParse(invalid[0]);
    expect(again.success).toBe(false);
    expect(first.success).toBe(false);
    if (!again.success && !first.success) {
      expect(again.error.issues).toEqual(first.error.issues);
    }
  });

  it('parses each page body instead of replaying a cached one', () => {
    const schema = PaginatedResponseSchema(z.object({ id: z.string() }));
    const first = schema.parse({
      data: [{ id: 'a' }],
      cursor: null,
      hasMore: false,
    });
    const second = schema.parse({
      data: [{ id: 'b' }],
      cursor: 'next',
      hasMore: true,
    });

    expect(first).toEqual({
      data: [{ id: 'a' }],
      cursor: null,
      hasMore: false,
    });
    expect(second).toEqual({
      data: [{ id: 'b' }],
      cursor: 'next',
      hasMore: true,
    });
  });

  it('reuses one schema object across module copies and not a lookalike', async () => {
    const dataSchema = z.object({ id: z.string() });
    const first = PaginatedResponseSchema(dataSchema);

    vi.resetModules();
    const fresh = await import('./shared.js');
    expect(fresh.PaginatedResponseSchema(dataSchema)).toBe(first);
    expect(
      fresh.PaginatedResponseSchema(z.object({ id: z.string() }))
    ).not.toBe(first);
  });
});
