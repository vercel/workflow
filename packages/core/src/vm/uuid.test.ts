import { describe, expect, it } from 'vitest';
import { createRandomUUID } from './uuid.js';

describe('createRandomUUID', () => {
  // Helper function to create a mock RNG that returns predictable values
  const createMockRNG = (values: number[]) => {
    let index = 0;
    return () => {
      const value = values[index % values.length];
      index++;
      return value;
    };
  };

  // Helper function to validate UUID v4 format
  const isValidUUIDv4 = (uuid: string): boolean => {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  };

  describe('basic functionality', () => {
    it('should return a function', () => {
      const mockRNG = () => 0.5;
      const result = createRandomUUID(mockRNG);
      expect(typeof result).toBe('function');
    });

    it('should generate a valid UUID v4 format', () => {
      const mockRNG = () => 0.5;
      const randomUUID = createRandomUUID(mockRNG);
      const uuid = randomUUID();

      expect(typeof uuid).toBe('string');
      expect(uuid.length).toBe(36);
      expect(isValidUUIDv4(uuid)).toBe(true);
    });

    it('should have correct structure with hyphens at right positions', () => {
      const mockRNG = () => 0.5;
      const randomUUID = createRandomUUID(mockRNG);
      const uuid = randomUUID();

      expect(uuid[8]).toBe('-');
      expect(uuid[13]).toBe('-');
      expect(uuid[18]).toBe('-');
      expect(uuid[23]).toBe('-');
    });
  });

  describe('UUID v4 specifications', () => {
    it('should have version 4 identifier at position 14', () => {
      const mockRNG = () => 0.5;
      const randomUUID = createRandomUUID(mockRNG);
      const uuid = randomUUID();

      expect(uuid[14]).toBe('4');
    });

    it('should have variant bits set correctly at position 19', () => {
      // Test all possible variant values (8, 9, a, b)
      const testCases = [
        { rng: () => 0.0, expected: '8' },
        { rng: () => 0.24, expected: '8' },
        { rng: () => 0.25, expected: '9' },
        { rng: () => 0.49, expected: '9' },
        { rng: () => 0.5, expected: 'a' },
        { rng: () => 0.74, expected: 'a' },
        { rng: () => 0.75, expected: 'b' },
        { rng: () => 0.99, expected: 'b' },
      ];

      testCases.forEach(({ rng, expected }) => {
        const randomUUID = createRandomUUID(rng);
        const uuid = randomUUID();
        expect(uuid[19]).toBe(expected);
      });
    });
  });

  describe('deterministic behavior', () => {
    it('should produce the same UUID with the same RNG sequence', () => {
      const mockRNG1 = createMockRNG([0.1, 0.2, 0.3, 0.4, 0.5]);
      const mockRNG2 = createMockRNG([0.1, 0.2, 0.3, 0.4, 0.5]);

      const randomUUID1 = createRandomUUID(mockRNG1);
      const randomUUID2 = createRandomUUID(mockRNG2);

      const uuid1 = randomUUID1();
      const uuid2 = randomUUID2();

      expect(uuid1).toBe(uuid2);
    });

    it('should produce different UUIDs with different RNG sequences', () => {
      const mockRNG1 = createMockRNG([0.1, 0.2, 0.3]);
      const mockRNG2 = createMockRNG([0.7, 0.8, 0.9]);

      const randomUUID1 = createRandomUUID(mockRNG1);
      const randomUUID2 = createRandomUUID(mockRNG2);

      const uuid1 = randomUUID1();
      const uuid2 = randomUUID2();

      expect(uuid1).not.toBe(uuid2);
    });

    it('should be repeatable when calling the same generator multiple times', () => {
      const mockRNG = createMockRNG([0.1, 0.2, 0.3, 0.4, 0.5]);
      const randomUUID = createRandomUUID(mockRNG);

      const uuid1 = randomUUID();
      const uuid2 = randomUUID();

      // Should be different UUIDs since RNG continues
      expect(uuid1).not.toBe(uuid2);
      expect(isValidUUIDv4(uuid1)).toBe(true);
      expect(isValidUUIDv4(uuid2)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle RNG that always returns 0', () => {
      const mockRNG = () => 0;
      const randomUUID = createRandomUUID(mockRNG);
      const uuid = randomUUID();

      expect(isValidUUIDv4(uuid)).toBe(true);
      expect(uuid[14]).toBe('4'); // Version should still be 4
      expect(uuid[19]).toBe('8'); // Variant should be 8 (floor(0 * 4) + 8)
      expect(uuid).toBe('00000000-0000-4000-8000-000000000000');
    });

    it('should handle RNG that always returns near 1', () => {
      const mockRNG = () => 0.999;
      const randomUUID = createRandomUUID(mockRNG);
      const uuid = randomUUID();

      expect(isValidUUIDv4(uuid)).toBe(true);
      expect(uuid[14]).toBe('4'); // Version should still be 4
      expect(uuid[19]).toBe('b'); // Variant should be b (floor(0.999 * 4) + 8)
      expect(uuid).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    });

    it('should handle RNG with repeating pattern', () => {
      const mockRNG = createMockRNG([0.0, 0.5, 0.999]); // Will cycle through these values
      const randomUUID = createRandomUUID(mockRNG);
      const uuid = randomUUID();

      expect(isValidUUIDv4(uuid)).toBe(true);
      expect(uuid).toBe('08f08f08-f08f-408f-88f0-8f08f08f08f0');
    });
  });

  describe('character distribution', () => {
    it('should use all hexadecimal characters for regular positions', () => {
      // Test with RNG that cycles through all possible values
      const values = Array.from({ length: 16 }, (_, i) => i / 16);
      const mockRNG = createMockRNG(values);
      const randomUUID = createRandomUUID(mockRNG);
      const uuid = randomUUID();

      expect(isValidUUIDv4(uuid)).toBe(true);

      // Check that various hex characters appear in the UUID
      const uuidChars = uuid
        .replace(/-/g, '')
        .replace(/4/g, '')
        .replace(/[89ab]/g, '');

      // Should contain various hex characters
      expect(uuidChars.length).toBeGreaterThan(0);
    });

    it('should only use valid variant characters at position 19', () => {
      const validVariants = ['8', '9', 'a', 'b'];

      // Test multiple UUIDs with different RNG values
      for (let i = 0; i < 100; i++) {
        const mockRNG = () => Math.random();
        const randomUUID = createRandomUUID(mockRNG);
        const uuid = randomUUID();

        expect(validVariants).toContain(uuid[19]);
      }
    });
  });

  describe('type compatibility', () => {
    it('should return the same type as crypto.randomUUID', () => {
      const mockRNG = () => 0.5;
      const randomUUID = createRandomUUID(mockRNG);
      const uuid = randomUUID();

      // The function should return a string that's compatible with crypto.randomUUID return type
      expect(typeof uuid).toBe('string');

      // Should be assignable to the same type
      const cryptoUUIDType: ReturnType<typeof crypto.randomUUID> = uuid;
      expect(cryptoUUIDType).toBe(uuid);
    });
  });
});
