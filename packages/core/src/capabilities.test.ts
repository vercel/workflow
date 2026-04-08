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

  describe('invalid or malformed version strings', () => {
    it.each([
      'dev',
      'not-a-version',
      '',
      '4.2',
      '4',
    ])('"%s" falls back to baseline formats without throwing', (version) => {
      const { supportedFormats } = getRunCapabilities(version);
      expect(supportedFormats.has(SerializationFormat.DEVALUE_V1)).toBe(true);
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(false);
    });
  });

  describe('v-prefixed versions', () => {
    it('handles v-prefixed version strings', () => {
      // semver.valid() coerces "v" prefix — this is valid input
      const { supportedFormats } = getRunCapabilities('v4.0.0');
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(true);
    });
  });

  describe('pre-encryption versions', () => {
    it.each([
      '3.9.9',
      '3.0.0',
      '2.0.0',
    ])('%s does not support encryption', (version) => {
      const { supportedFormats } = getRunCapabilities(version);
      expect(supportedFormats.has(SerializationFormat.DEVALUE_V1)).toBe(true);
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(false);
    });
  });

  describe('encryption-capable versions', () => {
    it('supports encryption at the exact cutoff version (4.0.0)', () => {
      const { supportedFormats } = getRunCapabilities('4.0.0');
      expect(supportedFormats.has(SerializationFormat.DEVALUE_V1)).toBe(true);
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(true);
    });

    it.each([
      '4.0.1-beta.27',
      '4.1.0-beta.63',
      '4.2.0-beta.64',
      '4.2.0',
      '5.0.0',
    ])('%s supports encryption', (version) => {
      const { supportedFormats } = getRunCapabilities(version);
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(true);
    });
  });
});
