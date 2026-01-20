import { inspect } from 'node:util';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import { describe, expect, it } from 'vitest';
import { registerSerializationClass } from './class-serialization.js';
import {
  CLASS_INSTANCE_REF_TYPE,
  ClassInstanceRef,
  extractStreamIds,
  hydrateResourceIO,
  isClassInstanceRef,
  isStreamId,
  isStreamRef,
  STREAM_REF_TYPE,
  truncateId,
} from './observability.js';
import { dehydrateStepReturnValue } from './serialization.js';

describe('ClassInstanceRef', () => {
  describe('constructor and properties', () => {
    it('should create instance with correct properties', () => {
      const ref = new ClassInstanceRef('Point', 'class//file.ts//Point', {
        x: 1,
        y: 2,
      });

      expect(ref.className).toBe('Point');
      expect(ref.classId).toBe('class//file.ts//Point');
      expect(ref.data).toEqual({ x: 1, y: 2 });
      expect(ref.__type).toBe(CLASS_INSTANCE_REF_TYPE);
    });

    it('should handle various data types', () => {
      // Object data
      const objRef = new ClassInstanceRef('Config', 'class//Config', {
        key: 'value',
      });
      expect(objRef.data).toEqual({ key: 'value' });

      // String data
      const strRef = new ClassInstanceRef('Token', 'class//Token', 'abc123');
      expect(strRef.data).toBe('abc123');

      // Number data
      const numRef = new ClassInstanceRef('Counter', 'class//Counter', 42);
      expect(numRef.data).toBe(42);

      // Null data
      const nullRef = new ClassInstanceRef('Empty', 'class//Empty', null);
      expect(nullRef.data).toBeNull();

      // Array data
      const arrRef = new ClassInstanceRef('List', 'class//List', [1, 2, 3]);
      expect(arrRef.data).toEqual([1, 2, 3]);
    });
  });

  describe('toJSON()', () => {
    it('should return plain object representation', () => {
      const ref = new ClassInstanceRef('Point', 'class//file.ts//Point', {
        x: 1,
        y: 2,
      });

      expect(ref.toJSON()).toEqual({
        __type: CLASS_INSTANCE_REF_TYPE,
        className: 'Point',
        classId: 'class//file.ts//Point',
        data: { x: 1, y: 2 },
      });
    });

    it('should be used by JSON.stringify', () => {
      const ref = new ClassInstanceRef('Point', 'class//file.ts//Point', {
        x: 1,
        y: 2,
      });

      const json = JSON.stringify(ref);
      const parsed = JSON.parse(json);

      expect(parsed).toEqual({
        __type: CLASS_INSTANCE_REF_TYPE,
        className: 'Point',
        classId: 'class//file.ts//Point',
        data: { x: 1, y: 2 },
      });
    });
  });

  describe('[inspect.custom]', () => {
    it('should render as ClassName@filename { data }', () => {
      const ref = new ClassInstanceRef(
        'Point',
        'class//workflows/user-signup.ts//Point',
        { x: 1, y: 2 }
      );

      const output = inspect(ref, { colors: false });
      expect(output).toBe('Point@user-signup.ts { x: 1, y: 2 }');
    });

    it('should handle nested file paths', () => {
      const ref = new ClassInstanceRef(
        'Config',
        'class//lib/models/config.ts//Config',
        { nested: { a: 1, b: 2 } }
      );

      const output = inspect(ref, { colors: false });
      expect(output).toBe('Config@config.ts { nested: { a: 1, b: 2 } }');
    });

    it('should handle string data', () => {
      const ref = new ClassInstanceRef(
        'Token',
        'class//auth/token.ts//Token',
        'secret'
      );

      const output = inspect(ref, { colors: false });
      expect(output).toBe("Token@token.ts 'secret'");
    });

    it('should handle null data', () => {
      const ref = new ClassInstanceRef(
        'Empty',
        'class//utils/empty.ts//Empty',
        null
      );

      const output = inspect(ref, { colors: false });
      expect(output).toBe('Empty@empty.ts null');
    });

    it('should handle array data', () => {
      const ref = new ClassInstanceRef(
        'List',
        'class//collections/list.ts//List',
        [1, 2, 3]
      );

      const output = inspect(ref, { colors: false });
      expect(output).toBe('List@list.ts [ 1, 2, 3 ]');
    });

    it('should handle simple classId format gracefully', () => {
      // Fallback for non-standard classId format
      const ref = new ClassInstanceRef('Point', 'test//TestPoint', {
        x: 1,
        y: 2,
      });

      const output = inspect(ref, { colors: false });
      // Falls back to extracting just the last segment as filename
      expect(output).toBe('Point@TestPoint { x: 1, y: 2 }');
    });

    it('should style @filename gray when colors are enabled', () => {
      const ref = new ClassInstanceRef(
        'Point',
        'class//workflows/point.ts//Point',
        { x: 1, y: 2 }
      );

      const output = inspect(ref, { colors: true });
      // When colors are enabled, the @filename should have ANSI escape codes
      expect(output).toContain('Point');
      // Check for ANSI escape codes (gray/dim styling for @filename)
      expect(output).toMatch(/\x1b\[90m@point\.ts\x1b\[39m/);
      // Data is also present (may have color codes for numbers)
      expect(output).toContain('x:');
      expect(output).toContain('y:');
    });
  });
});

describe('isClassInstanceRef', () => {
  it('should return true for ClassInstanceRef instances', () => {
    const ref = new ClassInstanceRef('Point', 'class//Point', { x: 1, y: 2 });
    expect(isClassInstanceRef(ref)).toBe(true);
  });

  it('should return true for plain objects with correct structure', () => {
    const plainObj = {
      __type: CLASS_INSTANCE_REF_TYPE,
      className: 'Point',
      classId: 'class//Point',
      data: { x: 1, y: 2 },
    };
    expect(isClassInstanceRef(plainObj)).toBe(true);
  });

  it('should return true for JSON-parsed ClassInstanceRef', () => {
    const ref = new ClassInstanceRef('Point', 'class//Point', { x: 1, y: 2 });
    const parsed = JSON.parse(JSON.stringify(ref));
    expect(isClassInstanceRef(parsed)).toBe(true);
  });

  it('should return false for null', () => {
    expect(isClassInstanceRef(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isClassInstanceRef(undefined)).toBe(false);
  });

  it('should return false for plain objects without __type', () => {
    expect(isClassInstanceRef({ className: 'Point', data: {} })).toBe(false);
  });

  it('should return false for objects with wrong __type', () => {
    expect(
      isClassInstanceRef({
        __type: 'wrong_type',
        className: 'Point',
        data: {},
      })
    ).toBe(false);
  });

  it('should return false for objects without className', () => {
    expect(
      isClassInstanceRef({
        __type: CLASS_INSTANCE_REF_TYPE,
        classId: 'class//Point',
        data: {},
      })
    ).toBe(false);
  });
});

describe('isStreamRef', () => {
  it('should return true for valid StreamRef', () => {
    const streamRef = {
      __type: STREAM_REF_TYPE,
      streamId: 'strm_123',
    };
    expect(isStreamRef(streamRef)).toBe(true);
  });

  it('should return false for null', () => {
    expect(isStreamRef(null)).toBe(false);
  });

  it('should return false for wrong __type', () => {
    expect(isStreamRef({ __type: 'wrong', streamId: 'strm_123' })).toBe(false);
  });
});

describe('isStreamId', () => {
  it('should return true for valid stream ID', () => {
    expect(isStreamId('strm_abc123')).toBe(true);
  });

  it('should return false for non-stream strings', () => {
    expect(isStreamId('not_a_stream')).toBe(false);
  });

  it('should return false for non-strings', () => {
    expect(isStreamId(123)).toBe(false);
    expect(isStreamId(null)).toBe(false);
    expect(isStreamId({})).toBe(false);
  });
});

describe('extractStreamIds', () => {
  it('should extract stream IDs from flat objects', () => {
    const obj = { stream: 'strm_123', other: 'not_stream' };
    expect(extractStreamIds(obj)).toEqual(['strm_123']);
  });

  it('should extract stream IDs from nested objects', () => {
    const obj = {
      level1: {
        level2: {
          stream: 'strm_abc',
        },
      },
    };
    expect(extractStreamIds(obj)).toEqual(['strm_abc']);
  });

  it('should extract stream IDs from arrays', () => {
    const arr = ['strm_1', 'strm_2', 'not_stream'];
    expect(extractStreamIds(arr)).toEqual(['strm_1', 'strm_2']);
  });

  it('should deduplicate stream IDs', () => {
    const obj = { a: 'strm_same', b: 'strm_same' };
    expect(extractStreamIds(obj)).toEqual(['strm_same']);
  });

  it('should return empty array for no streams', () => {
    expect(extractStreamIds({ foo: 'bar' })).toEqual([]);
  });
});

describe('truncateId', () => {
  it('should not truncate short IDs', () => {
    expect(truncateId('short', 12)).toBe('short');
  });

  it('should truncate long IDs', () => {
    expect(truncateId('verylongidentifier', 12)).toBe('verylongiden...');
  });

  it('should use default max length of 12', () => {
    expect(truncateId('123456789012')).toBe('123456789012');
    expect(truncateId('1234567890123')).toBe('123456789012...');
  });
});

describe('hydrateResourceIO with custom class instances', () => {
  // Create a test class with serialization symbols
  class TestPoint {
    constructor(
      public x: number,
      public y: number
    ) {}

    static [WORKFLOW_SERIALIZE](instance: TestPoint) {
      return { x: instance.x, y: instance.y };
    }

    static [WORKFLOW_DESERIALIZE](data: { x: number; y: number }) {
      return new TestPoint(data.x, data.y);
    }
  }

  // Register the class for serialization (so dehydrate works)
  // but note: in o11y context, classes are NOT registered, which is the point of this test
  (TestPoint as any).classId = 'test//TestPoint';
  registerSerializationClass('test//TestPoint', TestPoint);

  it('should convert Instance type to ClassInstanceRef in step output', () => {
    // Simulate serialized step data with a custom class instance
    const point = new TestPoint(3, 4);
    const serialized = dehydrateStepReturnValue(point, [], 'wrun_test');

    // Create a step resource with serialized output
    const step = {
      stepId: 'step_123',
      runId: 'wrun_test',
      output: serialized,
    };

    // Hydrate the step - this should convert Instance to ClassInstanceRef
    // because the class is not registered in the o11y context (streamPrintRevivers)
    const hydrated = hydrateResourceIO(step);

    // The output should be a ClassInstanceRef
    expect(isClassInstanceRef(hydrated.output)).toBe(true);
    expect(hydrated.output.className).toBe('TestPoint');
    expect(hydrated.output.classId).toBe('test//TestPoint');
    expect(hydrated.output.data).toEqual({ x: 3, y: 4 });
  });

  it('should preserve ClassInstanceRef through JSON roundtrip', () => {
    const ref = new ClassInstanceRef('Point', 'class//Point', { x: 1, y: 2 });
    const json = JSON.stringify(ref);
    const parsed = JSON.parse(json);

    // After parsing, it's a plain object but still recognized
    expect(isClassInstanceRef(parsed)).toBe(true);
    expect(parsed.className).toBe('Point');
    expect(parsed.classId).toBe('class//Point');
    expect(parsed.data).toEqual({ x: 1, y: 2 });
  });
});
