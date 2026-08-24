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
      // pre-cutoff: encryption introduced in 4.2.0-beta.64; framing ships
      // in the stable 4.6.0 release, so any earlier 4.x version is too old.
      // 4.5.0 in particular was published before the framing backport
      // merged, so it silently pipes framed bytes through to the user.
      '4.2.0-beta.64',
      '4.2.0',
      '4.4.0',
      '4.5.0',
      '4.5.1',
      // betas published before framing shipped must read as raw —
      // a false positive here means framed writes to a consumer that
      // cannot unframe them
      '4.6.0-beta.14',
      // 5.0.0 betas below beta.15 predate framing but compare above every
      // 4.x version, so they specifically must not match a plain >=4.6.0
      // check (runs created on those deployments record these versions)
      '5.0.0-beta.0',
      '5.0.0-beta.14',
    ])('is false for pre-framing version %s', (version) => {
      expect(getRunCapabilities(version).framedByteStreams).toBe(false);
    });

    it('is true at the exact stable cutoff version (4.6.0)', () => {
      expect(getRunCapabilities('4.6.0').framedByteStreams).toBe(true);
    });

    it('is true at the exact beta cutoff version (5.0.0-beta.15)', () => {
      expect(getRunCapabilities('5.0.0-beta.15').framedByteStreams).toBe(true);
    });

    it.each([
      '4.6.1',
      '4.7.0',
      '5.0.0-beta.16',
      '5.0.0',
      // future prereleases above the cutoff must be recognized as capable
      '5.1.0-beta.0',
      '6.0.0',
    ])('is true for post-framing version %s', (version) => {
      expect(getRunCapabilities(version).framedByteStreams).toBe(true);
    });
  });
});
