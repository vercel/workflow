import { describe, expect, it } from 'vitest';
import { getRunCapabilities } from './capabilities.js';
import { SerializationFormat } from './serialization.js';

describe('getRunCapabilities', () => {
  describe('undefined version (very old runs)', () => {
    it('only supports baseline formats', () => {
      const { supportedFormats } = getRunCapabilities(undefined);
      expect(supportedFormats.has(SerializationFormat.DEVALUE_V1)).toBe(true);
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(false);
    });
  });

  describe('pre-encryption versions', () => {
    it.each([
      '4.1.0-beta.63',
      '4.0.1-beta.27',
      '3.0.0',
    ])('%s does not support encryption', (version) => {
      const { supportedFormats } = getRunCapabilities(version);
      expect(supportedFormats.has(SerializationFormat.DEVALUE_V1)).toBe(true);
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(false);
    });
  });

  describe('encryption-capable versions', () => {
    it('supports encryption at the exact cutoff version', () => {
      const { supportedFormats } = getRunCapabilities('4.2.0-beta.64');
      expect(supportedFormats.has(SerializationFormat.DEVALUE_V1)).toBe(true);
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(true);
    });

    it.each([
      '4.2.0-beta.74',
      '4.2.0',
      '5.0.0',
    ])('%s supports encryption', (version) => {
      const { supportedFormats } = getRunCapabilities(version);
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(true);
    });
  });
});
