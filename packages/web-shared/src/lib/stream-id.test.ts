import { describe, expect, it } from 'vitest';
import { describeStreamId } from './stream-id';

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('describeStreamId', () => {
  it('labels the default user stream', () => {
    expect(describeStreamId('strm_01JXYZABCDEFGHIJKLMNOP_user')).toEqual({
      kind: 'user-default',
      label: 'Default stream',
    });
  });

  it('decodes the namespace of a named user stream', () => {
    const id = `strm_01JXYZABCDEFGHIJKLMNOP_user_${encodeBase64Url('my-namespace')}`;
    expect(describeStreamId(id)).toEqual({
      kind: 'user-named',
      label: 'my-namespace',
      namespace: 'my-namespace',
    });
  });

  it('decodes namespaces with characters outside base64', () => {
    const namespace = 'namespace:with/special@chars é 🎉';
    const id = `strm_abc123_user_${encodeBase64Url(namespace)}`;
    expect(describeStreamId(id)).toEqual({
      kind: 'user-named',
      label: namespace,
      namespace,
    });
  });

  it('labels abort-signal backing streams as system streams', () => {
    expect(
      describeStreamId('strm_01JXYZABCDEFGHIJKLMNOP_system_abort')
    ).toEqual({
      kind: 'system',
      label: 'Abort signal',
    });
  });

  it('passes through unrecognized formats verbatim', () => {
    expect(describeStreamId('__health_check__abc123')).toEqual({
      kind: 'unknown',
      label: '__health_check__abc123',
    });
    expect(describeStreamId('strm_known')).toEqual({
      kind: 'unknown',
      label: 'strm_known',
    });
  });

  it('passes through user streams whose namespace fails to decode', () => {
    expect(describeStreamId('strm_abc123_user_%%%')).toEqual({
      kind: 'unknown',
      label: 'strm_abc123_user_%%%',
    });
  });
});
