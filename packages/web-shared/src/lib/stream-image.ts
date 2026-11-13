/** Raster image signatures; stream names and caller-supplied types are untrusted. */
export function getStreamImageType(data: Uint8Array): string | null {
  const startsWith = (signature: number[]) =>
    signature.every((byte, index) => data[index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  const header = new TextDecoder().decode(data.subarray(0, 12));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif';
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
