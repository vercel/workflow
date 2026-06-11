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
      const { supportedFormats } = getRunCapabilities('v4.2.0-beta.64');
      expect(supportedFormats.has(SerializationFormat.ENCRYPTED)).toBe(true);
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

  describe('framedByteStreams (byte-stream wire framing)', () => {
    it('is false when version is undefined', () => {
      expect(getRunCapabilities(undefined).framedByteStreams).toBe(false);
    });

    it.each([
      'not-a-version',
      '',
      'dev',
    ])('is false for invalid version "%s"', (version) => {
      expect(getRunCapabilities(version).framedByteStreams).toBe(false);
    });

    it.each([
      // pre-cutoff: encryption introduced in 4.2.0-beta.64; framing is
      // newer than that, so any 4.x version is too old
      '4.2.0-beta.64',
      '4.2.0',
      '4.99.99',
      '5.0.0-beta.2',
      // betas published before framing shipped must read as raw —
      // a false positive here means framed writes to a consumer that
      // cannot unframe them
      '5.0.0-beta.14',
    ])('is false for pre-framing version %s', (version) => {
      expect(getRunCapabilities(version).framedByteStreams).toBe(false);
    });

    it('is true at the exact cutoff version (5.0.0-beta.15)', () => {
      expect(getRunCapabilities('5.0.0-beta.15').framedByteStreams).toBe(true);
    });

    it.each([
      '5.0.0-beta.16',
      '5.0.0',
      '5.1.0',
      '6.0.0',
    ])('is true for post-framing version %s', (version) => {
      expect(getRunCapabilities(version).framedByteStreams).toBe(true);
    });
  });
});
