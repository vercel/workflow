import * as z from 'zod';

export const Base64Buffer = z.codec(z.base64(), z.instanceof(Buffer), {
  decode(b64) {
    return Buffer.from(b64, 'base64');
  },
  encode(buf) {
    return buf.toString('base64');
  },
});
