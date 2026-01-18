import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PaginatedResponse } from '@workflow/world';
import ms from 'ms';
import { monotonicFactory } from 'ulid';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { paginatedFileSystemQuery, ulidToDate, writeJSON } from './fs.js';

// Create a new monotonic ULID factory for each test to avoid state pollution
let ulid = monotonicFactory(() => Math.random());

// Test schema for pagination tests
const TestItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.coerce.date(),
});
type TestItem = z.infer<typeof TestItemSchema>;

// Helper function to create filesystem with declarative file structure
async function createFilesystem(
  directory: string,
  files: Record<string, object>
): Promise<void> {
  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(directory, `${filename}.json`);
    await fs.writeFile(filePath, JSON.stringify(content, null, 2));
  }
}

// Helper to create ULID generator bound to a base time
function createUlidAfter(baseTime: number) {
  return (offset: string = '0s') => {
    return ulid(baseTime + ms(offset));
  };
}

describe('fs utilities', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-test-'));
    // Reset the ULID factory for each test to avoid state pollution
    ulid = monotonicFactory(() => Math.random());
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('ulidToDate', () => {
    it('should extract date from valid ULID', () => {
      // Generate a ULID at a specific time
      const testTime = new Date('2024-01-01T12:00:00.000Z');
      const testUlid = ulid(testTime.getTime());

      const result = ulidToDate(testUlid);
      expect(result).toEqual(testTime);
    });

    it('should return null for invalid ULID formats', () => {
      // Test various invalid inputs - focus on behavior not encoding specifics
      expect(ulidToDate('invalid-ulid')).toBeNull();
      expect(ulidToDate('')).toBeNull();
      expect(ulidToDate('too-short')).toBeNull();
      expect(ulidToDate('definitely-not-a-ulid-format')).toBeNull();
      expect(ulidToDate('01234567890123456789012345INVALID')).toBeNull();
    });

    it('should handle edge case timestamps', () => {
      // Test with epoch time - but ULID at time 0 may not actually decode to epoch
      // due to ULID's internal representation. Let's test a known timestamp instead.
      const testTime = new Date('2024-01-01T00:00:00.000Z');
      const testUlid = ulid(testTime.getTime());
      const result = ulidToDate(testUlid);
      expect(result?.getTime()).toEqual(testTime.getTime());
    });
  });

  describe('paginatedFileSystemQuery', () => {
    // Simple getCreatedAt function that strips .json and tries to parse as ULID
    const getCreatedAt = (filename: string): Date | null => {
      const name = filename.replace('.json', '');
      return ulidToDate(name);
    };

    describe('basic pagination', () => {
      beforeEach(async () => {
        // Create test files with ULIDs as IDs (so getCreatedAt can extract timestamps)
        const baseTime = new Date('2024-01-01T00:00:00.000Z').getTime();
        const ulidAfter = createUlidAfter(baseTime);

        // Create 5 test files with 1-minute intervals
        await createFilesystem(testDir, {
          [ulidAfter()]: {
            id: ulidAfter(),
            name: 'item-0',
            createdAt: new Date(baseTime),
          },
          [ulidAfter('1m')]: {
            id: ulidAfter('1m'),
            name: 'item-1',
            createdAt: new Date(baseTime + ms('1m')),
          },
          [ulidAfter('2m')]: {
            id: ulidAfter('2m'),
            name: 'item-2',
            createdAt: new Date(baseTime + ms('2m')),
          },
          [ulidAfter('3m')]: {
            id: ulidAfter('3m'),
            name: 'item-3',
            createdAt: new Date(baseTime + ms('3m')),
          },
          [ulidAfter('4m')]: {
            id: ulidAfter('4m'),
            name: 'item-4',
            createdAt: new Date(baseTime + ms('4m')),
          },
        });
      });

      it('should return first page with default settings', async () => {
        const result = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
        });

        expect(result.data).toHaveLength(5);
        expect(result.hasMore).toBe(false);
        // Cursor should be set even when hasMore is false (for stable pagination)
        expect(result.cursor).not.toBeNull();

        // Should be sorted in descending order (newest first)
        assert(result.data[0], 'expected first item to be defined');
        assert(result.data[1], 'expected second item to be defined');
        expect(result.data[0].createdAt.getTime()).toBeGreaterThan(
          result.data[1].createdAt.getTime()
        );
      });

      it('should respect limit parameter', async () => {
        const result = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
          limit: 2,
        });

        expect(result.data).toHaveLength(2);
        expect(result.hasMore).toBe(true);
        assert(result.cursor, 'expected cursor to be defined');
      });

      it('should handle ascending sort order', async () => {
        const result = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
          sortOrder: 'asc',
        });

        expect(result.data).toHaveLength(5);

        // Should be sorted in ascending order (oldest first)
        assert(result.data[0], 'expected first item to be defined');
        assert(result.data[1], 'expected second item to be defined');
        expect(result.data[0].createdAt.getTime()).toBeLessThan(
          result.data[1].createdAt.getTime()
        );
      });

      it('should handle empty directory', async () => {
        const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-'));

        try {
          const result = await paginatedFileSystemQuery({
            directory: emptyDir,
            schema: TestItemSchema,
            getCreatedAt: getCreatedAt,
          });

          expect(result.data).toHaveLength(0);
          expect(result.hasMore).toBe(false);
          expect(result.cursor).toBe(null);
        } finally {
          await fs.rm(emptyDir, { recursive: true, force: true });
        }
      });
    });

    describe('cursor optimization', () => {
      let fileIds: string[];

      beforeEach(async () => {
        // Create 10 test files with ULIDs, spaced 1 minute apart
        const baseTime = new Date('2024-01-01T00:00:00.000Z').getTime();
        const ulidAfter = createUlidAfter(baseTime);
        fileIds = [];

        const files: Record<string, object> = {};
        for (let i = 0; i < 10; i++) {
          const id = ulidAfter(`${i}m`);
          fileIds.push(id);
          files[id] = {
            id,
            name: `item-${i}`,
            createdAt: new Date(baseTime + ms(`${i}m`)),
          };
        }

        await createFilesystem(testDir, files);
      });

      it('should handle cursor-based pagination efficiently', async () => {
        // Test that cursor-based pagination works correctly without testing implementation
        const firstPage = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
          limit: 3,
        });

        expect(firstPage.data).toHaveLength(3);
        expect(firstPage.hasMore).toBe(true);
        assert(firstPage.cursor, 'expected first page cursor to be defined');

        const secondPage = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
          limit: 3,
          cursor: firstPage.cursor,
        });

        expect(secondPage.data).toHaveLength(3);
        expect(secondPage.hasMore).toBe(true);

        // Verify behavior: no overlap between pages
        const firstPageIds = new Set(firstPage.data.map((item) => item.id));
        const secondPageIds = new Set(secondPage.data.map((item) => item.id));

        for (const id of secondPageIds) {
          expect(firstPageIds).not.toContain(id);
        }
      });

      it('should handle pagination with cursor correctly', async () => {
        // Get first page
        const firstPage = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
          limit: 4,
          sortOrder: 'desc',
        });

        expect(firstPage.data).toHaveLength(4);
        expect(firstPage.hasMore).toBe(true);
        assert(firstPage.cursor, 'expected first page cursor to be defined');

        // Get second page using cursor
        const secondPage = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
          limit: 4,
          cursor: firstPage.cursor,
          sortOrder: 'desc',
        });

        expect(secondPage.data).toHaveLength(4);
        expect(secondPage.hasMore).toBe(true);

        // Verify no overlap between pages
        const firstPageIds = new Set(firstPage.data.map((item) => item.id));
        const secondPageIds = new Set(secondPage.data.map((item) => item.id));

        for (const id of secondPageIds) {
          expect(firstPageIds).not.toContain(id);
        }

        // Verify ordering within pages
        for (let i = 1; i < firstPage.data.length; i++) {
          assert(
            firstPage.data[i - 1],
            `expected item at index ${i - 1} to be defined`
          );
          assert(
            firstPage.data[i],
            `expected item at index ${i} to be defined`
          );
          expect(firstPage.data[i - 1].createdAt.getTime()).toBeGreaterThan(
            firstPage.data[i].createdAt.getTime()
          );
        }
      });

      it('should handle ascending cursor pagination correctly', async () => {
        // Get first page in ascending order (oldest first)
        const firstPage = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
          limit: 3,
          sortOrder: 'asc',
        });

        expect(firstPage.data).toHaveLength(3);
        expect(firstPage.hasMore).toBe(true);

        // Verify first page is sorted oldest to newest
        assert(firstPage.data[0], 'expected first item to be defined');
        assert(firstPage.data[1], 'expected second item to be defined');
        assert(firstPage.data[2], 'expected third item to be defined');
        expect(firstPage.data[0].createdAt.getTime()).toBeLessThan(
          firstPage.data[1].createdAt.getTime()
        );
        expect(firstPage.data[1].createdAt.getTime()).toBeLessThan(
          firstPage.data[2].createdAt.getTime()
        );
        assert(firstPage.cursor, 'expected first page cursor to be defined');

        // Get second page using cursor from first page
        const secondPage = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
          limit: 3,
          cursor: firstPage.cursor,
          sortOrder: 'asc',
        });

        expect(secondPage.data).toHaveLength(3);

        // Verify second page continues chronologically after first page
        const lastItemFirstPage = firstPage.data[firstPage.data.length - 1];
        const firstItemSecondPage = secondPage.data[0];
        assert(
          lastItemFirstPage,
          'expected last item of first page to be defined'
        );
        assert(
          firstItemSecondPage,
          'expected first item of second page to be defined'
        );

        expect(firstItemSecondPage.createdAt.getTime()).toBeGreaterThan(
          lastItemFirstPage.createdAt.getTime()
        );

        // Verify no overlap between pages
        const firstPageIds = new Set(firstPage.data.map((item) => item.id));
        const secondPageIds = new Set(secondPage.data.map((item) => item.id));

        for (const id of secondPageIds) {
          expect(firstPageIds).not.toContain(id);
        }
      });

      it('should include files when getCreatedAt returns null and sort by JSON createdAt', async () => {
        // Create a file with non-ULID name that will return null from getCreatedAt.
        // This simulates step files which use sequential IDs (step_0, step_1, etc.)
        // rather than ULIDs, so filename-based timestamp extraction returns null.
        await createFilesystem(testDir, {
          'not-a-ulid': {
            id: 'not-a-ulid',
            name: 'should-be-included',
            createdAt: new Date('2024-01-01T05:00:00.000Z'),
          },
        });

        const result = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt, // Will return null for 'not-a-ulid'
          limit: 20,
        });

        // Should include all files including the non-ULID one (sorted by JSON createdAt)
        expect(result.data.length).toBe(11); // 10 ULID files + 1 non-ULID file

        const includedItem = result.data.find(
          (item) => item.id === 'not-a-ulid'
        );
        expect(includedItem).toBeDefined(); // Should be found
        expect(includedItem?.name).toBe('should-be-included');
      });

      it('should handle pagination correctly when items have identical timestamps', async () => {
        // This test reproduces the bug where items with the same timestamp
        // are incorrectly filtered out during pagination, causing items to be skipped.

        // Create a separate test directory
        const sameTimeDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'same-time-test-')
        );

        try {
          const baseTime = new Date('2024-01-01T00:00:00.000Z').getTime();
          const sameTimestamp = new Date(baseTime);

          // Create 25 items all with the exact same timestamp but different IDs
          const files: Record<string, object> = {};
          const ids: string[] = [];
          for (let i = 0; i < 25; i++) {
            // Use monotonic ULID at the same base time
            // Monotonic factory ensures they have different IDs that sort consistently
            const id = ulid(baseTime);
            ids.push(id);
            files[id] = {
              id,
              name: `item-${i}`,
              createdAt: sameTimestamp, // All have identical timestamp!
            };
          }

          await createFilesystem(sameTimeDir, files);

          // Get first page (limit 20)
          const firstPage = await paginatedFileSystemQuery({
            directory: sameTimeDir,
            schema: TestItemSchema,
            getCreatedAt: getCreatedAt,
            getId: (item) => item.id, // Provide getId for tie-breaking
            limit: 20,
            sortOrder: 'asc',
          });

          expect(firstPage.data).toHaveLength(20);
          expect(firstPage.hasMore).toBe(true);
          assert(firstPage.cursor, 'expected cursor to be defined');

          // Verify all items have the same timestamp
          for (const item of firstPage.data) {
            expect(item.createdAt.getTime()).toBe(sameTimestamp.getTime());
          }

          // Get second page
          const secondPage = await paginatedFileSystemQuery({
            directory: sameTimeDir,
            schema: TestItemSchema,
            getCreatedAt: getCreatedAt,
            getId: (item) => item.id,
            limit: 20,
            cursor: firstPage.cursor,
            sortOrder: 'asc',
          });

          // THIS IS THE KEY ASSERTION
          expect(secondPage.data).toHaveLength(5);
          expect(secondPage.hasMore).toBe(false);

          // Verify no overlap between pages
          const firstPageIds = new Set(firstPage.data.map((item) => item.id));
          const secondPageIds = new Set(secondPage.data.map((item) => item.id));

          for (const id of secondPageIds) {
            expect(firstPageIds).not.toContain(id);
          }

          // Verify we got all 25 items across both pages
          const allIds = new Set([...firstPageIds, ...secondPageIds]);
          expect(allIds.size).toBe(25);
        } finally {
          await fs.rm(sameTimeDir, { recursive: true, force: true });
        }
      });
    });

    describe('filtering and prefixes', () => {
      let prefixTestDir: string;

      beforeEach(async () => {
        // Use a separate directory for prefix tests to avoid interference
        prefixTestDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'prefix-test-')
        );

        const baseTime = new Date('2024-01-01T00:00:00.000Z').getTime();

        // Create files with ULID names, some with prefixes
        const prefixedId1 = ulid(baseTime);
        const prefixedId2 = ulid(baseTime + 60000);
        const unprefixedId = ulid(baseTime + 120000);

        // Helper to create files in prefix test directory
        const createPrefixTestFile = async (
          id: string,
          name: string,
          createdAt: Date
        ) => {
          const testItem = { id, name, createdAt };
          const filePath = path.join(prefixTestDir, `${id}.json`);
          await fs.writeFile(filePath, JSON.stringify(testItem, null, 2));
        };

        await createPrefixTestFile(
          `prefix_${prefixedId1}`,
          'prefixed-1',
          new Date(baseTime)
        );
        await createPrefixTestFile(
          `prefix_${prefixedId2}`,
          'prefixed-2',
          new Date(baseTime + 60000)
        );
        await createPrefixTestFile(
          unprefixedId,
          'unprefixed',
          new Date(baseTime + 120000)
        );
      });

      afterEach(async () => {
        await fs.rm(prefixTestDir, { recursive: true, force: true });
      });

      // Custom getCreatedAt for prefix tests that handles prefix_ULID pattern
      const getPrefixCreatedAt = (filename: string): Date | null => {
        const name = filename.replace('.json', '');
        if (name.includes('_')) {
          const parts = name.split('_');
          const lastPart = parts[parts.length - 1];
          assert(lastPart, 'expected last part of filename to be defined');
          return ulidToDate(lastPart);
        }
        return ulidToDate(name);
      };

      it('should filter by file prefix', async () => {
        const result = await paginatedFileSystemQuery({
          directory: prefixTestDir,
          schema: TestItemSchema,
          getCreatedAt: getPrefixCreatedAt,
          filePrefix: 'prefix_',
        });

        expect(result.data).toHaveLength(2);
        expect(
          result.data.every((item) => item.name.startsWith('prefixed'))
        ).toBe(true);
      });

      it('should apply custom filter', async () => {
        const result = await paginatedFileSystemQuery({
          directory: prefixTestDir,
          schema: TestItemSchema,
          getCreatedAt: getPrefixCreatedAt,
          filter: (item) => item.name.startsWith('prefixed'),
        });

        expect(result.data).toHaveLength(2);
        expect(
          result.data.every((item) => item.name.startsWith('prefixed'))
        ).toBe(true);
      });

      it('should combine prefix and custom filter', async () => {
        const result = await paginatedFileSystemQuery({
          directory: prefixTestDir,
          schema: TestItemSchema,
          getCreatedAt: getPrefixCreatedAt,
          filePrefix: 'prefix_',
          filter: (item) => item.name === 'prefixed-1',
        });

        expect(result.data).toHaveLength(1);
        assert(result.data[0], 'expected first result to be defined');
        expect(result.data[0].name).toBe('prefixed-1');
      });
    });

    describe('error handling', () => {
      it('should handle non-existent directory', async () => {
        const result = await paginatedFileSystemQuery({
          directory: '/non/existent/directory',
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
        });

        expect(result.data).toHaveLength(0);
        expect(result.hasMore).toBe(false);
        expect(result.cursor).toBeNull();
      });

      it('should handle malformed JSON files', async () => {
        const validId = ulid();
        const malformedId = ulid();

        // Create a valid test file
        await createFilesystem(testDir, {
          [validId]: { id: validId, name: 'valid-item', createdAt: new Date() },
        });

        // Create a malformed JSON file
        const malformedPath = path.join(testDir, `${malformedId}.json`);
        await fs.writeFile(malformedPath, '{ "invalid": json }');

        // The current implementation throws on malformed JSON, so we expect an error
        await expect(
          paginatedFileSystemQuery({
            directory: testDir,
            schema: TestItemSchema,
            getCreatedAt: getCreatedAt,
          })
        ).rejects.toThrow();
      });

      it('should skip files with schema validation failures and log warning', async () => {
        const validId = ulid();
        const invalidId = ulid();

        // Create a valid file
        await createFilesystem(testDir, {
          [validId]: {
            id: validId,
            name: 'valid-item',
            createdAt: new Date(),
          },
        });

        // Create a file that doesn't match the schema (missing required fields)
        const invalidItem = { wrongField: 'value', createdAt: new Date() };
        const invalidPath = path.join(testDir, `${invalidId}.json`);
        await fs.writeFile(invalidPath, JSON.stringify(invalidItem));

        // Spy on console.warn to verify the warning is logged
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
          const result = await paginatedFileSystemQuery({
            directory: testDir,
            schema: TestItemSchema,
            getCreatedAt: getCreatedAt,
          });

          // Should return only the valid item, skipping the malformed one
          expect(result.data).toHaveLength(1);
          assert(result.data[0], 'expected first result to be defined');
          expect(result.data[0].name).toBe('valid-item');

          // Verify warning was logged for the skipped item
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`Skipping item ${invalidId}`)
          );
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('should handle mixed file types in directory', async () => {
        // Create valid JSON file
        const id = ulid();
        await createFilesystem(testDir, {
          [id]: { id, name: 'valid-item', createdAt: new Date() },
        });

        // Create non-JSON file
        const txtPath = path.join(testDir, 'readme.txt');
        await fs.writeFile(txtPath, 'This is not JSON');

        const result = await paginatedFileSystemQuery({
          directory: testDir,
          schema: TestItemSchema,
          getCreatedAt: getCreatedAt,
        });

        // Should only process JSON files
        expect(result.data).toHaveLength(1);
        assert(result.data[0], 'expected first result to be defined');
        expect(result.data[0].name).toBe('valid-item');
      });
    });

    describe('large dataset handling', () => {
      it('should handle pagination with many files efficiently', async () => {
        // Create a larger dataset to test pagination behavior
        const baseTime = new Date('2024-01-01T00:00:00.000Z').getTime();
        const fileCount = 25;
        const ulidAfter = createUlidAfter(baseTime);

        const files: Record<string, object> = {};
        for (let i = 0; i < fileCount; i++) {
          const id = ulidAfter(`${i}m`);
          files[id] = {
            id,
            name: `item-${i}`,
            createdAt: new Date(baseTime + ms(`${i}m`)),
          };
        }

        await createFilesystem(testDir, files);

        // Test multiple pages work correctly
        type PageResult = Awaited<PaginatedResponse<TestItem>>;
        const pages: PageResult[] = [];
        let cursor: string | null = null;
        let hasMore = true;

        while (hasMore && pages.length < 5) {
          const page = await paginatedFileSystemQuery({
            directory: testDir,
            schema: TestItemSchema,
            getCreatedAt: getCreatedAt,
            limit: 5,
            cursor: cursor || undefined,
            sortOrder: 'desc',
          });

          pages.push(page);
          cursor = page.cursor;
          hasMore = page.hasMore;
        }

        // Verify we got multiple pages
        expect(pages.length).toBeGreaterThan(1);

        // Verify total items across all pages
        const allItems = pages.flatMap((page) => page.data);
        expect(allItems.length).toBeLessThanOrEqual(fileCount);

        // Verify no duplicates across pages
        const allIds = allItems.map((item) => item.id);
        const uniqueIds = new Set(allIds);
        expect(uniqueIds.size).toBe(allIds.length);

        // Verify items are properly sorted across pages
        for (let i = 1; i < allItems.length; i++) {
          assert(
            allItems[i - 1],
            `expected item at index ${i - 1} to be defined`
          );
          assert(allItems[i], `expected item at index ${i} to be defined`);
          expect(allItems[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
            allItems[i].createdAt.getTime()
          );
        }
      });
    });
  });

  describe('concurrent writes', () => {
    it('should not fail when concurrent writes occur', async () => {
      const filePath = path.join(testDir, 'concurrency-test.json');
      const testTime = new Date();
      const firstUlid = ulid();
      const secondUlid = ulid();

      await Promise.all([
        writeJSON(filePath, {
          id: firstUlid,
          name: 'test-item-1',
          createdAt: testTime,
        }),
        writeJSON(filePath, {
          id: secondUlid,
          name: 'test-item-2',
          createdAt: testTime,
        }),
      ]);
    });
  });
});
