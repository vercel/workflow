import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createContext } from './index.js';

const seed = 'entropy seed';
const fixedTimestamp = 1234567890000;

describe('Uint8Array base64/hex polyfill', () => {
  describe('Uint8Array.prototype.toBase64()', () => {
    it('should encode a Uint8Array to base64', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]).toBase64()',
        context
      );
      expect(result).toEqual('SGVsbG8gV29ybGQ=');
    });

    it('should encode an empty Uint8Array', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext('new Uint8Array([]).toBase64()', context);
      expect(result).toEqual('');
    });

    it('should encode a single byte', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([72]).toBase64()',
        context
      );
      expect(result).toEqual('SA==');
    });

    it('should encode two bytes', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([72, 101]).toBase64()',
        context
      );
      expect(result).toEqual('SGU=');
    });

    it('should support base64url alphabet', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([251, 255, 191]).toBase64({ alphabet: "base64url" })',
        context
      );
      expect(result).toEqual('-_-_');
    });

    it('should support standard base64 alphabet explicitly', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([251, 255, 191]).toBase64({ alphabet: "base64" })',
        context
      );
      expect(result).toEqual('+/+/');
    });

    it('should support omitPadding option', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([72]).toBase64({ omitPadding: true })',
        context
      );
      expect(result).toEqual('SA');
    });

    it('should include padding by default', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([72]).toBase64()',
        context
      );
      expect(result).toEqual('SA==');
    });

    it('should throw TypeError for invalid alphabet', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext(
          'new Uint8Array([72]).toBase64({ alphabet: "invalid" })',
          context
        )
      ).toThrow(TypeError);
    });
  });

  describe('Uint8Array.prototype.toHex()', () => {
    it('should encode a Uint8Array to hex', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]).toHex()',
        context
      );
      expect(result).toEqual('48656c6c6f20576f726c64');
    });

    it('should encode an empty Uint8Array', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext('new Uint8Array([]).toHex()', context);
      expect(result).toEqual('');
    });

    it('should pad single-digit hex values with zero', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([0, 1, 15]).toHex()',
        context
      );
      expect(result).toEqual('00010f');
    });

    it('should encode 0xDE 0xAD 0xBE 0xEF', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]).toHex()',
        context
      );
      expect(result).toEqual('deadbeef');
    });
  });

  describe('Uint8Array.fromBase64()', () => {
    it('should decode a base64 string to Uint8Array', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'Array.from(Uint8Array.fromBase64("SGVsbG8gV29ybGQ="))',
        context
      );
      expect(result).toEqual([
        72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100,
      ]);
    });

    it('should decode an empty string', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'Array.from(Uint8Array.fromBase64(""))',
        context
      );
      expect(result).toEqual([]);
    });

    it('should handle whitespace in base64 input', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'Array.from(Uint8Array.fromBase64("SGVs bG8g\\nV29y bGQ="))',
        context
      );
      expect(result).toEqual([
        72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100,
      ]);
    });

    it('should handle missing padding in loose mode (default)', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'Array.from(Uint8Array.fromBase64("SGVsbG8gV29ybGQ"))',
        context
      );
      expect(result).toEqual([
        72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100,
      ]);
    });

    it('should support base64url alphabet', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'Array.from(Uint8Array.fromBase64("-_-_", { alphabet: "base64url" }))',
        context
      );
      expect(result).toEqual([251, 255, 191]);
    });

    it('should reject + and / in base64url mode', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext(
          'Uint8Array.fromBase64("+/+/", { alphabet: "base64url" })',
          context
        )
      ).toThrow(SyntaxError);
    });

    it('should throw TypeError for non-string input', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext('Uint8Array.fromBase64(123)', context)
      ).toThrow(TypeError);
    });

    it('should throw TypeError for invalid alphabet', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext(
          'Uint8Array.fromBase64("AA==", { alphabet: "invalid" })',
          context
        )
      ).toThrow(TypeError);
    });

    it('should throw SyntaxError for invalid base64 characters', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext('Uint8Array.fromBase64("$$$$")', context)
      ).toThrow(SyntaxError);
    });

    it('should throw SyntaxError for lone character in loose mode', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext('Uint8Array.fromBase64("A")', context)
      ).toThrow(SyntaxError);
    });

    describe('lastChunkHandling: "strict"', () => {
      it('should reject missing padding', () => {
        const { context } = createContext({ seed, fixedTimestamp });
        expect(() =>
          vm.runInContext(
            'Uint8Array.fromBase64("SGVsbG8gV29ybGQ", { lastChunkHandling: "strict" })',
            context
          )
        ).toThrow(SyntaxError);
      });

      it('should reject non-zero overflow bits', () => {
        const { context } = createContext({ seed, fixedTimestamp });
        // "SGVsbG8gV29ybGR=" has non-zero overflow bits
        expect(() =>
          vm.runInContext(
            'Uint8Array.fromBase64("SGVsbG8gV29ybGR=", { lastChunkHandling: "strict" })',
            context
          )
        ).toThrow(SyntaxError);
      });

      it('should accept properly padded input', () => {
        const { context } = createContext({ seed, fixedTimestamp });
        const result = vm.runInContext(
          'Array.from(Uint8Array.fromBase64("SGVsbG8gV29ybGQ=", { lastChunkHandling: "strict" }))',
          context
        );
        expect(result).toEqual([
          72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100,
        ]);
      });
    });

    describe('lastChunkHandling: "stop-before-partial"', () => {
      it('should stop before a partial chunk', () => {
        const { context } = createContext({ seed, fixedTimestamp });
        // "SGVsbG8gV29ybGQ" has 15 chars, last chunk is "bGQ" (3 chars, partial)
        const result = vm.runInContext(
          'Array.from(Uint8Array.fromBase64("SGVsbG8gV29ybGQ", { lastChunkHandling: "stop-before-partial" }))',
          context
        );
        // Should decode only the first 12 base64 chars (3 full chunks = 9 bytes)
        expect(result).toEqual([72, 101, 108, 108, 111, 32, 87, 111, 114]);
      });

      it('should decode complete chunks fully', () => {
        const { context } = createContext({ seed, fixedTimestamp });
        const result = vm.runInContext(
          'Array.from(Uint8Array.fromBase64("SGVs", { lastChunkHandling: "stop-before-partial" }))',
          context
        );
        expect(result).toEqual([72, 101, 108]);
      });
    });
  });

  describe('Uint8Array.fromHex()', () => {
    it('should decode a hex string to Uint8Array', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'Array.from(Uint8Array.fromHex("48656c6c6f20576f726c64"))',
        context
      );
      expect(result).toEqual([
        72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100,
      ]);
    });

    it('should decode an empty string', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'Array.from(Uint8Array.fromHex(""))',
        context
      );
      expect(result).toEqual([]);
    });

    it('should handle uppercase hex characters', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'Array.from(Uint8Array.fromHex("DEADBEEF"))',
        context
      );
      expect(result).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it('should handle mixed case hex characters', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        'Array.from(Uint8Array.fromHex("DeAdBeEf"))',
        context
      );
      expect(result).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it('should throw SyntaxError for odd-length string', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext('Uint8Array.fromHex("abc")', context)
      ).toThrow(SyntaxError);
    });

    it('should throw SyntaxError for invalid hex characters', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext('Uint8Array.fromHex("gg")', context)
      ).toThrow(SyntaxError);
    });

    it('should throw TypeError for non-string input', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() => vm.runInContext('Uint8Array.fromHex(123)', context)).toThrow(
        TypeError
      );
    });
  });

  describe('Uint8Array.prototype.setFromBase64()', () => {
    it('should write decoded base64 into an existing Uint8Array', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        `
        const target = new Uint8Array(7);
        const result = target.setFromBase64("Zm9vYmFy");
        ({ read: result.read, written: result.written, bytes: Array.from(target) });
        `,
        context
      );
      expect(result.read).toEqual(8);
      expect(result.written).toEqual(6);
      expect(result.bytes).toEqual([102, 111, 111, 98, 97, 114, 0]);
    });

    it('should truncate when target is smaller than decoded data', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        `
        const target = new Uint8Array(3);
        const result = target.setFromBase64("Zm9vYmFy");
        ({ read: result.read, written: result.written, bytes: Array.from(target) });
        `,
        context
      );
      expect(result.written).toEqual(3);
      expect(result.bytes).toEqual([102, 111, 111]);
    });

    it('should support base64url alphabet', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        `
        const target = new Uint8Array(3);
        const result = target.setFromBase64("-_-_", { alphabet: "base64url" });
        ({ read: result.read, written: result.written, bytes: Array.from(target) });
        `,
        context
      );
      expect(result.written).toEqual(3);
      expect(result.bytes).toEqual([251, 255, 191]);
    });

    it('should throw TypeError for non-string input', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext('new Uint8Array(4).setFromBase64(123)', context)
      ).toThrow(TypeError);
    });
  });

  describe('Uint8Array.prototype.setFromHex()', () => {
    it('should write decoded hex into an existing Uint8Array', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        `
        const target = new Uint8Array(6);
        const result = target.setFromHex("deadbeef");
        ({ read: result.read, written: result.written, bytes: Array.from(target) });
        `,
        context
      );
      expect(result.read).toEqual(8);
      expect(result.written).toEqual(4);
      expect(result.bytes).toEqual([0xde, 0xad, 0xbe, 0xef, 0, 0]);
    });

    it('should truncate when target is smaller than decoded data', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        `
        const target = new Uint8Array(2);
        const result = target.setFromHex("deadbeef");
        ({ read: result.read, written: result.written, bytes: Array.from(target) });
        `,
        context
      );
      expect(result.written).toEqual(2);
      expect(result.bytes).toEqual([0xde, 0xad]);
    });

    it('should throw SyntaxError for odd-length string', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext('new Uint8Array(4).setFromHex("abc")', context)
      ).toThrow(SyntaxError);
    });

    it('should throw TypeError for non-string input', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      expect(() =>
        vm.runInContext('new Uint8Array(4).setFromHex(123)', context)
      ).toThrow(TypeError);
    });
  });

  describe('roundtrip encoding/decoding', () => {
    it('should roundtrip base64 encoding and decoding', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        `
        const original = new Uint8Array([0, 1, 2, 127, 128, 255]);
        const encoded = original.toBase64();
        const decoded = Uint8Array.fromBase64(encoded);
        Array.from(decoded);
        `,
        context
      );
      expect(result).toEqual([0, 1, 2, 127, 128, 255]);
    });

    it('should roundtrip base64url encoding and decoding', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        `
        const original = new Uint8Array([251, 255, 191, 0, 63]);
        const encoded = original.toBase64({ alphabet: "base64url" });
        const decoded = Uint8Array.fromBase64(encoded, { alphabet: "base64url" });
        Array.from(decoded);
        `,
        context
      );
      expect(result).toEqual([251, 255, 191, 0, 63]);
    });

    it('should roundtrip hex encoding and decoding', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        `
        const original = new Uint8Array([0, 1, 2, 127, 128, 255]);
        const encoded = original.toHex();
        const decoded = Uint8Array.fromHex(encoded);
        Array.from(decoded);
        `,
        context
      );
      expect(result).toEqual([0, 1, 2, 127, 128, 255]);
    });

    it('should allow creating basic auth headers using base64', () => {
      const { context } = createContext({ seed, fixedTimestamp });
      const result = vm.runInContext(
        `
        const str = "api_key:api_secret";
        const encoded = new Uint8Array(Array.from(str).map(c => c.charCodeAt(0)));
        const b64 = encoded.toBase64();
        const decoded = Uint8Array.fromBase64(b64);
        String.fromCharCode(...decoded);
        `,
        context
      );
      expect(result).toEqual('api_key:api_secret');
    });
  });
});
