import { describe, expect, it } from 'vitest';
import { getRunCapabilities } from './capabilities.js';
import { SerializationFormat } from './serialization.js';
import { version as ownVersion } from './version.js';

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

  describe('queue hookInput support (resilient resumeHook)', () => {
    it.each([
      undefined,
      'dev',
      '4.3.1',
      '5.0.0-beta.7',
      '5.0.0-beta.13',
    ])('is not supported for runs recorded by older/unknown versions (%s)', (version) => {
      // Published runtimes predating the feature parse the queue payload
      // with a schema that strips `hookInput`; the resilient path must be
      // disabled for runs they created. Note: the own-version exact match
      // below makes the current dev version supported, so this case list
      // must not contain `ownVersion` — guard against that.
      if (version === ownVersion) return;
      const { supportsQueueHookInput } = getRunCapabilities(version);
      expect(supportsQueueHookInput).toBe(false);
    });

    it('is supported for runs created by the same build line (own version)', () => {
      const { supportsQueueHookInput } = getRunCapabilities(ownVersion);
      expect(supportsQueueHookInput).toBe(true);
    });

    it('is supported for versions at/above the release cutoff', () => {
      expect(getRunCapabilities('5.0.0-beta.14').supportsQueueHookInput).toBe(
        true
      );
      expect(getRunCapabilities('5.0.0').supportsQueueHookInput).toBe(true);
      expect(getRunCapabilities('5.1.2').supportsQueueHookInput).toBe(true);
    });
  });
});
