/**
 * Polyfill for the TC39 Uint8Array base64/hex proposal (Stage 4).
 *
 * Implements:
 *  - Uint8Array.prototype.toBase64([options])
 *  - Uint8Array.prototype.toHex()
 *  - Uint8Array.fromBase64(string[, options])
 *  - Uint8Array.fromHex(string)
 *  - Uint8Array.prototype.setFromBase64(string[, options])
 *  - Uint8Array.prototype.setFromHex(string)
 *
 * @see https://tc39.es/proposal-arraybuffer-base64/spec/
 */

// Local type definitions for the polyfilled methods. These are intentionally
// NOT `declare global` to avoid leaking types to host-side code — the polyfill
// is only installed inside the workflow VM context.
interface Uint8ArrayWithBase64 extends Uint8Array {
  toBase64(options?: { alphabet?: string; omitPadding?: boolean }): string;
  toHex(): string;
  setFromBase64(
    str: string,
    options?: { alphabet?: string; lastChunkHandling?: string }
  ): { read: number; written: number };
  setFromHex(str: string): { read: number; written: number };
}

interface Uint8ArrayConstructorWithBase64 extends Uint8ArrayConstructor {
  fromBase64(
    str: string,
    options?: { alphabet?: string; lastChunkHandling?: string }
  ): Uint8Array;
  fromHex(str: string): Uint8Array;
}

type Base64Alphabet = 'base64' | 'base64url';
type LastChunkHandling = 'loose' | 'strict' | 'stop-before-partial';

interface ToBase64Options {
  alphabet?: Base64Alphabet;
  omitPadding?: boolean;
}

interface FromBase64Options {
  alphabet?: Base64Alphabet;
  lastChunkHandling?: LastChunkHandling;
}

interface SetFromResult {
  read: number;
  written: number;
}

// Standard base64 alphabet
const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Reverse lookup table: char code -> index (for standard base64 alphabet)
const BASE64_LOOKUP = new Uint8Array(128).fill(255);
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
}

// ASCII whitespace characters per spec: TAB, LF, FF, CR, SPACE
function isAsciiWhitespace(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20
  );
}

function skipAsciiWhitespace(str: string, index: number): number {
  while (index < str.length && isAsciiWhitespace(str.charCodeAt(index))) {
    index++;
  }
  return index;
}

function decodeBase64Chunk(
  chunk: string,
  throwOnExtraBits?: boolean
): number[] {
  const chunkLength = chunk.length;
  let padded = chunk;
  if (chunkLength === 2) {
    padded = chunk + 'AA';
  } else if (chunkLength === 3) {
    padded = chunk + 'A';
  }

  // Decode 4 base64 chars to 3 bytes
  const b0 = BASE64_LOOKUP[padded.charCodeAt(0)];
  const b1 = BASE64_LOOKUP[padded.charCodeAt(1)];
  const b2 = BASE64_LOOKUP[padded.charCodeAt(2)];
  const b3 = BASE64_LOOKUP[padded.charCodeAt(3)];

  const byte0 = (b0 << 2) | (b1 >> 4);
  const byte1 = ((b1 & 0x0f) << 4) | (b2 >> 2);
  const byte2 = ((b2 & 0x03) << 6) | b3;

  if (chunkLength === 2) {
    if (throwOnExtraBits && byte1 !== 0) {
      throw new SyntaxError('Extra bits in base64 chunk');
    }
    return [byte0];
  }
  if (chunkLength === 3) {
    if (throwOnExtraBits && byte2 !== 0) {
      throw new SyntaxError('Extra bits in base64 chunk');
    }
    return [byte0, byte1];
  }
  return [byte0, byte1, byte2];
}

interface FromBase64Result {
  read: number;
  bytes: number[];
  error: SyntaxError | null;
}

function fromBase64(
  str: string,
  alphabet: Base64Alphabet,
  lastChunkHandling: LastChunkHandling,
  maxLength?: number
): FromBase64Result {
  if (maxLength === undefined) {
    maxLength = Number.MAX_SAFE_INTEGER;
  }
  if (maxLength === 0) {
    return { read: 0, bytes: [], error: null };
  }

  let read = 0;
  const bytes: number[] = [];
  let chunk = '';
  let chunkLength = 0;
  let index = 0;
  const length = str.length;

  while (true) {
    index = skipAsciiWhitespace(str, index);

    if (index === length) {
      if (chunkLength > 0) {
        if (lastChunkHandling === 'stop-before-partial') {
          return { read, bytes, error: null };
        }
        if (lastChunkHandling === 'loose') {
          if (chunkLength === 1) {
            return {
              read,
              bytes,
              error: new SyntaxError(
                'Invalid base64: lone character in final chunk'
              ),
            };
          }
          bytes.push(...decodeBase64Chunk(chunk, false));
        } else {
          // strict
          return {
            read,
            bytes,
            error: new SyntaxError(
              'Invalid base64: incomplete chunk in strict mode'
            ),
          };
        }
      }
      return { read: length, bytes, error: null };
    }

    let char = str[index];
    index++;

    if (char === '=') {
      if (chunkLength < 2) {
        return {
          read,
          bytes,
          error: new SyntaxError('Invalid base64: padding in unexpected place'),
        };
      }

      index = skipAsciiWhitespace(str, index);

      if (chunkLength === 2) {
        if (index === length) {
          if (lastChunkHandling === 'stop-before-partial') {
            return { read, bytes, error: null };
          }
          return {
            read,
            bytes,
            error: new SyntaxError(
              'Invalid base64: missing second padding character'
            ),
          };
        }
        char = str[index];
        if (char === '=') {
          index = skipAsciiWhitespace(str, index + 1);
        }
      }

      if (index < length) {
        return {
          read,
          bytes,
          error: new SyntaxError(
            'Invalid base64: unexpected characters after padding'
          ),
        };
      }

      const throwOnExtraBits = lastChunkHandling === 'strict';
      try {
        bytes.push(...decodeBase64Chunk(chunk, throwOnExtraBits));
      } catch (e) {
        return { read, bytes, error: e as SyntaxError };
      }
      return { read: length, bytes, error: null };
    }

    if (alphabet === 'base64url') {
      if (char === '+' || char === '/') {
        return {
          read,
          bytes,
          error: new SyntaxError(
            `Invalid base64url: unexpected character '${char}'`
          ),
        };
      }
      if (char === '-') {
        char = '+';
      } else if (char === '_') {
        char = '/';
      }
    }

    // Validate character is in the standard base64 alphabet
    const code = char.charCodeAt(0);
    if (code >= 128 || BASE64_LOOKUP[code] === 255) {
      return {
        read,
        bytes,
        error: new SyntaxError(
          `Invalid base64: unexpected character '${str[index - 1]}'`
        ),
      };
    }

    // Check if adding this character would exceed maxLength
    const remaining = maxLength - bytes.length;
    if (
      (remaining === 1 && chunkLength === 2) ||
      (remaining === 2 && chunkLength === 3)
    ) {
      return { read, bytes, error: null };
    }

    chunk += char;
    chunkLength = chunk.length;

    if (chunkLength === 4) {
      bytes.push(...decodeBase64Chunk(chunk));
      chunk = '';
      chunkLength = 0;
      read = index;

      if (bytes.length === maxLength) {
        return { read, bytes, error: null };
      }
    }
  }
}

interface FromHexResult {
  read: number;
  bytes: number[];
  error: SyntaxError | null;
}

function fromHex(str: string, maxLength?: number): FromHexResult {
  if (maxLength === undefined) {
    maxLength = Number.MAX_SAFE_INTEGER;
  }

  const length = str.length;
  const bytes: number[] = [];
  let read = 0;

  if (length % 2 !== 0) {
    return {
      read: 0,
      bytes: [],
      error: new SyntaxError('Invalid hex: string length must be even'),
    };
  }

  while (read < length && bytes.length < maxLength) {
    const hexits = str.substring(read, read + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(hexits)) {
      return {
        read,
        bytes,
        error: new SyntaxError(
          `Invalid hex: unexpected character at position ${read}`
        ),
      };
    }
    read += 2;
    bytes.push(Number.parseInt(hexits, 16));
  }

  return { read, bytes, error: null };
}

function toBase64(uint8: Uint8Array, options?: ToBase64Options): string {
  const alphabet: Base64Alphabet = options?.alphabet ?? 'base64';
  if (alphabet !== 'base64' && alphabet !== 'base64url') {
    throw new TypeError(
      `Invalid alphabet: expected "base64" or "base64url", got "${alphabet}"`
    );
  }
  const omitPadding = Boolean(options?.omitPadding);

  let result = '';
  const len = uint8.length;

  for (let i = 0; i < len; i += 3) {
    const b0 = uint8[i];
    const b1 = i + 1 < len ? uint8[i + 1] : 0;
    const b2 = i + 2 < len ? uint8[i + 2] : 0;

    result += BASE64_CHARS[(b0 >> 2) & 0x3f];
    result += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0f)];

    if (i + 1 < len) {
      result += BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 >> 6) & 0x03)];
    } else if (!omitPadding) {
      result += '=';
    }

    if (i + 2 < len) {
      result += BASE64_CHARS[b2 & 0x3f];
    } else if (!omitPadding) {
      result += '=';
    }
  }

  if (alphabet === 'base64url') {
    result = result.replace(/\+/g, '-').replace(/\//g, '_');
  }

  return result;
}

function toHex(uint8: Uint8Array): string {
  let out = '';
  for (let i = 0; i < uint8.length; i++) {
    out += uint8[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Installs the Uint8Array base64/hex polyfill onto the given
 * Uint8Array constructor and prototype. This is designed to be
 * used inside the workflow VM context, operating on the VM's
 * own Uint8Array rather than the host's.
 */
export function installUint8ArrayBase64(
  Uint8ArrayCtor: typeof Uint8Array
): void {
  const proto = Uint8ArrayCtor.prototype as Uint8ArrayWithBase64;
  const ctor = Uint8ArrayCtor as Uint8ArrayConstructorWithBase64;

  // Uint8Array.prototype.toBase64([options])
  if (!proto.toBase64) {
    Object.defineProperty(proto, 'toBase64', {
      value: function toBase64Method(
        this: Uint8Array,
        options?: ToBase64Options
      ): string {
        if (!(this instanceof Uint8ArrayCtor)) {
          throw new TypeError('this is not a Uint8Array');
        }
        return toBase64(this, options);
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  // Uint8Array.prototype.toHex()
  if (!proto.toHex) {
    Object.defineProperty(proto, 'toHex', {
      value: function toHexMethod(this: Uint8Array): string {
        if (!(this instanceof Uint8ArrayCtor)) {
          throw new TypeError('this is not a Uint8Array');
        }
        return toHex(this);
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  // Uint8Array.prototype.setFromBase64(string[, options])
  if (!proto.setFromBase64) {
    Object.defineProperty(proto, 'setFromBase64', {
      value: function setFromBase64Method(
        this: Uint8Array,
        str: string,
        options?: FromBase64Options
      ): SetFromResult {
        if (!(this instanceof Uint8ArrayCtor)) {
          throw new TypeError('this is not a Uint8Array');
        }
        if (typeof str !== 'string') {
          throw new TypeError('expected a string');
        }
        const alphabet: Base64Alphabet = options?.alphabet ?? 'base64';
        if (alphabet !== 'base64' && alphabet !== 'base64url') {
          throw new TypeError(
            `Invalid alphabet: expected "base64" or "base64url", got "${alphabet}"`
          );
        }
        const lastChunkHandling: LastChunkHandling =
          options?.lastChunkHandling ?? 'loose';
        if (
          lastChunkHandling !== 'loose' &&
          lastChunkHandling !== 'strict' &&
          lastChunkHandling !== 'stop-before-partial'
        ) {
          throw new TypeError(
            `Invalid lastChunkHandling: expected "loose", "strict", or "stop-before-partial", got "${lastChunkHandling}"`
          );
        }

        const result = fromBase64(
          str,
          alphabet,
          lastChunkHandling,
          this.length
        );
        const bytes = result.bytes;
        const written = bytes.length;

        for (let i = 0; i < written; i++) {
          this[i] = bytes[i];
        }

        if (result.error) {
          throw result.error;
        }

        return { read: result.read, written };
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  // Uint8Array.prototype.setFromHex(string)
  if (!proto.setFromHex) {
    Object.defineProperty(proto, 'setFromHex', {
      value: function setFromHexMethod(
        this: Uint8Array,
        str: string
      ): SetFromResult {
        if (!(this instanceof Uint8ArrayCtor)) {
          throw new TypeError('this is not a Uint8Array');
        }
        if (typeof str !== 'string') {
          throw new TypeError('expected a string');
        }

        const result = fromHex(str, this.length);
        const bytes = result.bytes;
        const written = bytes.length;

        for (let i = 0; i < written; i++) {
          this[i] = bytes[i];
        }

        if (result.error) {
          throw result.error;
        }

        return { read: result.read, written };
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  // Uint8Array.fromBase64(string[, options])
  if (!ctor.fromBase64) {
    Object.defineProperty(Uint8ArrayCtor, 'fromBase64', {
      value: function fromBase64Static(
        str: string,
        options?: FromBase64Options
      ): Uint8Array {
        if (typeof str !== 'string') {
          throw new TypeError('expected a string');
        }
        const alphabet: Base64Alphabet = options?.alphabet ?? 'base64';
        if (alphabet !== 'base64' && alphabet !== 'base64url') {
          throw new TypeError(
            `Invalid alphabet: expected "base64" or "base64url", got "${alphabet}"`
          );
        }
        const lastChunkHandling: LastChunkHandling =
          options?.lastChunkHandling ?? 'loose';
        if (
          lastChunkHandling !== 'loose' &&
          lastChunkHandling !== 'strict' &&
          lastChunkHandling !== 'stop-before-partial'
        ) {
          throw new TypeError(
            `Invalid lastChunkHandling: expected "loose", "strict", or "stop-before-partial", got "${lastChunkHandling}"`
          );
        }

        const result = fromBase64(str, alphabet, lastChunkHandling);
        if (result.error) {
          throw result.error;
        }

        return new Uint8ArrayCtor(result.bytes);
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  // Uint8Array.fromHex(string)
  if (!ctor.fromHex) {
    Object.defineProperty(Uint8ArrayCtor, 'fromHex', {
      value: function fromHexStatic(str: string): Uint8Array {
        if (typeof str !== 'string') {
          throw new TypeError('expected a string');
        }

        const result = fromHex(str);
        if (result.error) {
          throw result.error;
        }

        return new Uint8ArrayCtor(result.bytes);
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}
