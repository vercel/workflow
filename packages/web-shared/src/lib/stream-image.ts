const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87A = ascii('GIF87a');
const GIF89A = ascii('GIF89a');
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');

/** Raster image signatures; stream names and caller-supplied types are untrusted. */
export function getStreamImageType(data: Uint8Array): string | null {
  // Compare raw bytes: a WebP's RIFF size field (bytes 4-7) is binary and
  // can form multi-byte UTF-8, so decoding the header as text misaligns it.
  const matches = (signature: number[], offset = 0) =>
    signature.every((byte, index) => data[offset + index] === byte);
  if (matches(PNG)) return 'image/png';
  if (matches(JPEG)) return 'image/jpeg';
  if (matches(GIF87A) || matches(GIF89A)) return 'image/gif';
  if (matches(RIFF) && matches(WEBP, 8)) return 'image/webp';
  return null;
}
