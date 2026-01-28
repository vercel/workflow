import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
import { _ as __name } from "../index.mjs";
import { l as libExports } from "./_libs/@mongodb-js/zstd.mjs";
import { c as compressjs } from "../_libs/compressjs.mjs";
import "./_libs/@vercel/functions.mjs";
import "../_libs/srvx.mjs";
import "node:http";
import "node:stream";
import "node:https";
import "node:http2";
import "../_libs/h3.mjs";
import "../_libs/rou3.mjs";
import "../_libs/ms.mjs";
import "../_libs/ulid.mjs";
import "node:crypto";
import "node:module";
import "node:path";
import "node:child_process";
import "node:fs/promises";
import "node:util";
import "node:url";
import "node:timers/promises";
import "./_libs/@vercel/queue.mjs";
import "../_libs/mixpart.mjs";
import "./_libs/@vercel/oidc.mjs";
import "path";
import "fs";
import "os";
import "./_libs/async-sema.mjs";
import "events";
import "./_libs/undici.mjs";
import "node:assert";
import "node:net";
import "node:buffer";
import "node:querystring";
import "node:events";
import "node:diagnostics_channel";
import "node:tls";
import "node:zlib";
import "node:perf_hooks";
import "node:util/types";
import "node:worker_threads";
import "node:async_hooks";
import "node:console";
import "node:dns";
import "string_decoder";
import "../_libs/zod.mjs";
import "node:fs";
import "node:os";
import "../_libs/cbor-x.mjs";
import "../_libs/devalue.mjs";
import "./_libs/debug.mjs";
import "tty";
import "util";
import "../_libs/supports-color.mjs";
import "../_libs/has-flag.mjs";
import "./_libs/@jridgewell/trace-mapping.mjs";
import "./_libs/@jridgewell/sourcemap-codec.mjs";
import "./_libs/@jridgewell/resolve-uri.mjs";
import "node:vm";
import "../_libs/nanoid.mjs";
import "../_libs/seedrandom.mjs";
import "../_libs/ufo.mjs";
import "util/types";
import "../_libs/amdefine.mjs";
var BLOCK_SIZE = 512;
var BLOCK_SIZE_MASK = 511;
var DEFAULT_FILE_MODE = 420;
var DEFAULT_DIR_MODE = 493;
var USTAR_NAME_OFFSET = 0;
var USTAR_NAME_SIZE = 100;
var USTAR_MODE_OFFSET = 100;
var USTAR_MODE_SIZE = 8;
var USTAR_UID_OFFSET = 108;
var USTAR_UID_SIZE = 8;
var USTAR_GID_OFFSET = 116;
var USTAR_GID_SIZE = 8;
var USTAR_SIZE_OFFSET = 124;
var USTAR_SIZE_SIZE = 12;
var USTAR_MTIME_OFFSET = 136;
var USTAR_MTIME_SIZE = 12;
var USTAR_CHECKSUM_OFFSET = 148;
var USTAR_CHECKSUM_SIZE = 8;
var USTAR_TYPEFLAG_OFFSET = 156;
var USTAR_TYPEFLAG_SIZE = 1;
var USTAR_LINKNAME_OFFSET = 157;
var USTAR_LINKNAME_SIZE = 100;
var USTAR_MAGIC_OFFSET = 257;
var USTAR_MAGIC_SIZE = 6;
var USTAR_VERSION_OFFSET = 263;
var USTAR_VERSION_SIZE = 2;
var USTAR_UNAME_OFFSET = 265;
var USTAR_UNAME_SIZE = 32;
var USTAR_GNAME_OFFSET = 297;
var USTAR_GNAME_SIZE = 32;
var USTAR_PREFIX_OFFSET = 345;
var USTAR_PREFIX_SIZE = 155;
var USTAR_VERSION = "00";
var USTAR_MAX_UID_GID = 2097151;
var USTAR_MAX_SIZE = 8589934591;
var FILE = "file";
var LINK = "link";
var SYMLINK = "symlink";
var DIRECTORY = "directory";
var TYPEFLAG = {
  file: "0",
  link: "1",
  symlink: "2",
  "character-device": "3",
  "block-device": "4",
  directory: "5",
  fifo: "6",
  "pax-header": "x",
  "pax-global-header": "g",
  "gnu-long-name": "L",
  "gnu-long-link-name": "K"
};
var FLAGTYPE = {
  "0": FILE,
  "1": LINK,
  "2": SYMLINK,
  "3": "character-device",
  "4": "block-device",
  "5": DIRECTORY,
  "6": "fifo",
  x: "pax-header",
  g: "pax-global-header",
  L: "gnu-long-name",
  K: "gnu-long-link-name"
};
var ZERO_BLOCK = new Uint8Array(BLOCK_SIZE);
var EMPTY = new Uint8Array(0);
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function writeString(view, offset, size, value) {
  if (value) encoder.encodeInto(value, view.subarray(offset, offset + size));
}
__name(writeString, "writeString");
function writeOctal(view, offset, size, value) {
  if (value === void 0) return;
  const octalString = value.toString(8).padStart(size - 1, "0");
  encoder.encodeInto(octalString, view.subarray(offset, offset + size - 1));
}
__name(writeOctal, "writeOctal");
function readString(view, offset, size) {
  const end = view.indexOf(0, offset);
  const sliceEnd = end === -1 || end > offset + size ? offset + size : end;
  return decoder.decode(view.subarray(offset, sliceEnd));
}
__name(readString, "readString");
function readOctal(view, offset, size) {
  let value = 0;
  const end = offset + size;
  for (let i = offset; i < end; i++) {
    const charCode = view[i];
    if (charCode === 0) break;
    if (charCode === 32) continue;
    value = value * 8 + (charCode - 48);
  }
  return value;
}
__name(readOctal, "readOctal");
function readNumeric(view, offset, size) {
  if (view[offset] & 128) {
    let result = 0;
    result = view[offset] & 127;
    for (let i = 1; i < size; i++) result = result * 256 + view[offset + i];
    if (!Number.isSafeInteger(result)) throw new Error("TAR number too large");
    return result;
  }
  return readOctal(view, offset, size);
}
__name(readNumeric, "readNumeric");
var isBodyless = /* @__PURE__ */ __name((header) => header.type === DIRECTORY || header.type === SYMLINK || header.type === LINK, "isBodyless");
async function normalizeBody(body) {
  if (body === null || body === void 0) return EMPTY;
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new TypeError("Unsupported content type for entry body.");
}
__name(normalizeBody, "normalizeBody");
function transformHeader(header, options) {
  const { strip, filter, map } = options;
  if (!strip && !filter && !map) return header;
  const h = { ...header };
  if (strip && strip > 0) {
    const components = h.name.split("/").filter(Boolean);
    if (strip >= components.length) return null;
    const newName = components.slice(strip).join("/");
    h.name = h.type === DIRECTORY && !newName.endsWith("/") ? `${newName}/` : newName;
    if (h.linkname?.startsWith("/")) {
      const linkComponents = h.linkname.split("/").filter(Boolean);
      h.linkname = strip >= linkComponents.length ? "/" : `/${linkComponents.slice(strip).join("/")}`;
    }
  }
  if (filter?.(h) === false) return null;
  const result = map ? map(h) : h;
  if (result && (!result.name || !result.name.trim() || result.name === "." || result.name === "/")) return null;
  return result;
}
__name(transformHeader, "transformHeader");
var CHECKSUM_SPACE = 32;
var ASCII_ZERO = 48;
function validateChecksum(block) {
  const stored = readOctal(block, USTAR_CHECKSUM_OFFSET, USTAR_CHECKSUM_SIZE);
  let sum = 0;
  for (let i = 0; i < block.length; i++) if (i >= USTAR_CHECKSUM_OFFSET && i < USTAR_CHECKSUM_OFFSET + USTAR_CHECKSUM_SIZE) sum += CHECKSUM_SPACE;
  else sum += block[i];
  return stored === sum;
}
__name(validateChecksum, "validateChecksum");
function writeChecksum(block) {
  block.fill(CHECKSUM_SPACE, USTAR_CHECKSUM_OFFSET, USTAR_CHECKSUM_OFFSET + USTAR_CHECKSUM_SIZE);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  for (let i = USTAR_CHECKSUM_OFFSET + 6 - 1; i >= USTAR_CHECKSUM_OFFSET; i--) {
    block[i] = (checksum & 7) + ASCII_ZERO;
    checksum >>= 3;
  }
  block[USTAR_CHECKSUM_OFFSET + 6] = 0;
  block[USTAR_CHECKSUM_OFFSET + 7] = CHECKSUM_SPACE;
}
__name(writeChecksum, "writeChecksum");
function generatePax(header) {
  const paxRecords = {};
  if (header.name.length > USTAR_NAME_SIZE) {
    if (findUstarSplit(header.name) === null) paxRecords.path = header.name;
  }
  if (header.linkname && header.linkname.length > USTAR_NAME_SIZE) paxRecords.linkpath = header.linkname;
  if (header.uname && header.uname.length > USTAR_UNAME_SIZE) paxRecords.uname = header.uname;
  if (header.gname && header.gname.length > USTAR_GNAME_SIZE) paxRecords.gname = header.gname;
  if (header.uid != null && header.uid > USTAR_MAX_UID_GID) paxRecords.uid = String(header.uid);
  if (header.gid != null && header.gid > USTAR_MAX_UID_GID) paxRecords.gid = String(header.gid);
  if (header.size != null && header.size > USTAR_MAX_SIZE) paxRecords.size = String(header.size);
  if (header.pax) Object.assign(paxRecords, header.pax);
  const paxEntries = Object.entries(paxRecords);
  if (paxEntries.length === 0) return null;
  const paxBody = encoder.encode(paxEntries.map(([key, value]) => {
    const record = `${key}=${value}
`;
    const partLength = encoder.encode(record).length + 1;
    let totalLength = partLength + String(partLength).length;
    totalLength = partLength + String(totalLength).length;
    return `${totalLength} ${record}`;
  }).join(""));
  return {
    paxHeader: createTarHeader({
      name: decoder.decode(encoder.encode(`PaxHeader/${header.name}`).slice(0, 100)),
      size: paxBody.length,
      type: "pax-header",
      mode: 420,
      mtime: header.mtime,
      uname: header.uname,
      gname: header.gname,
      uid: header.uid,
      gid: header.gid
    }),
    paxBody
  };
}
__name(generatePax, "generatePax");
function findUstarSplit(path) {
  if (path.length <= USTAR_NAME_SIZE) return null;
  const minSlashIndex = path.length - USTAR_NAME_SIZE - 1;
  const slashIndex = path.lastIndexOf("/", USTAR_PREFIX_SIZE);
  if (slashIndex > 0 && slashIndex >= minSlashIndex) return {
    prefix: path.slice(0, slashIndex),
    name: path.slice(slashIndex + 1)
  };
  return null;
}
__name(findUstarSplit, "findUstarSplit");
function createTarHeader(header) {
  const view = new Uint8Array(BLOCK_SIZE);
  const size = isBodyless(header) ? 0 : header.size ?? 0;
  let name = header.name;
  let prefix = "";
  if (!header.pax?.path) {
    const split = findUstarSplit(name);
    if (split) {
      name = split.name;
      prefix = split.prefix;
    }
  }
  writeString(view, USTAR_NAME_OFFSET, USTAR_NAME_SIZE, name);
  writeOctal(view, USTAR_MODE_OFFSET, USTAR_MODE_SIZE, header.mode ?? (header.type === DIRECTORY ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE));
  writeOctal(view, USTAR_UID_OFFSET, USTAR_UID_SIZE, header.uid ?? 0);
  writeOctal(view, USTAR_GID_OFFSET, USTAR_GID_SIZE, header.gid ?? 0);
  writeOctal(view, USTAR_SIZE_OFFSET, USTAR_SIZE_SIZE, size);
  writeOctal(view, USTAR_MTIME_OFFSET, USTAR_MTIME_SIZE, Math.floor((header.mtime?.getTime() ?? Date.now()) / 1e3));
  writeString(view, USTAR_TYPEFLAG_OFFSET, USTAR_TYPEFLAG_SIZE, TYPEFLAG[header.type ?? FILE]);
  writeString(view, USTAR_LINKNAME_OFFSET, USTAR_LINKNAME_SIZE, header.linkname);
  writeString(view, USTAR_MAGIC_OFFSET, USTAR_MAGIC_SIZE, "ustar\0");
  writeString(view, USTAR_VERSION_OFFSET, USTAR_VERSION_SIZE, USTAR_VERSION);
  writeString(view, USTAR_UNAME_OFFSET, USTAR_UNAME_SIZE, header.uname);
  writeString(view, USTAR_GNAME_OFFSET, USTAR_GNAME_SIZE, header.gname);
  writeString(view, USTAR_PREFIX_OFFSET, USTAR_PREFIX_SIZE, prefix);
  writeChecksum(view);
  return view;
}
__name(createTarHeader, "createTarHeader");
function parseUstarHeader(block, strict) {
  if (strict && !validateChecksum(block)) throw new Error("Invalid tar header checksum.");
  const typeflag = readString(block, USTAR_TYPEFLAG_OFFSET, USTAR_TYPEFLAG_SIZE);
  const header = {
    name: readString(block, USTAR_NAME_OFFSET, USTAR_NAME_SIZE),
    mode: readOctal(block, USTAR_MODE_OFFSET, USTAR_MODE_SIZE),
    uid: readNumeric(block, USTAR_UID_OFFSET, USTAR_UID_SIZE),
    gid: readNumeric(block, USTAR_GID_OFFSET, USTAR_GID_SIZE),
    size: readNumeric(block, USTAR_SIZE_OFFSET, USTAR_SIZE_SIZE),
    mtime: /* @__PURE__ */ new Date(readNumeric(block, USTAR_MTIME_OFFSET, USTAR_MTIME_SIZE) * 1e3),
    type: FLAGTYPE[typeflag] || FILE,
    linkname: readString(block, USTAR_LINKNAME_OFFSET, USTAR_LINKNAME_SIZE)
  };
  const magic = readString(block, USTAR_MAGIC_OFFSET, USTAR_MAGIC_SIZE);
  if (magic.trim() === "ustar") {
    header.uname = readString(block, USTAR_UNAME_OFFSET, USTAR_UNAME_SIZE);
    header.gname = readString(block, USTAR_GNAME_OFFSET, USTAR_GNAME_SIZE);
  }
  if (magic === "ustar") header.prefix = readString(block, USTAR_PREFIX_OFFSET, USTAR_PREFIX_SIZE);
  return header;
}
__name(parseUstarHeader, "parseUstarHeader");
var PAX_MAPPING = {
  path: ["name", (v) => v],
  linkpath: ["linkname", (v) => v],
  size: ["size", (v) => parseInt(v, 10)],
  mtime: ["mtime", parseFloat],
  uid: ["uid", (v) => parseInt(v, 10)],
  gid: ["gid", (v) => parseInt(v, 10)],
  uname: ["uname", (v) => v],
  gname: ["gname", (v) => v]
};
function parsePax(buffer) {
  const decoder$1 = new TextDecoder("utf-8");
  const overrides = {};
  const pax = {};
  let offset = 0;
  while (offset < buffer.length) {
    const spaceIndex = buffer.indexOf(32, offset);
    if (spaceIndex === -1) break;
    const length = parseInt(decoder$1.decode(buffer.subarray(offset, spaceIndex)), 10);
    if (Number.isNaN(length) || length === 0) break;
    const recordEnd = offset + length;
    const [key, value] = decoder$1.decode(buffer.subarray(spaceIndex + 1, recordEnd - 1)).split("=", 2);
    if (key && value !== void 0) {
      pax[key] = value;
      const mapping = PAX_MAPPING[key];
      if (mapping) {
        const [targetKey, parser] = mapping;
        const parsedValue = parser(value);
        if (typeof parsedValue === "string" || !Number.isNaN(parsedValue)) overrides[targetKey] = parsedValue;
      }
    }
    offset = recordEnd;
  }
  if (Object.keys(pax).length > 0) overrides.pax = pax;
  return overrides;
}
__name(parsePax, "parsePax");
function applyOverrides(header, overrides) {
  if (overrides.name !== void 0) header.name = overrides.name;
  if (overrides.linkname !== void 0) header.linkname = overrides.linkname;
  if (overrides.size !== void 0) header.size = overrides.size;
  if (overrides.mtime !== void 0) header.mtime = /* @__PURE__ */ new Date(overrides.mtime * 1e3);
  if (overrides.uid !== void 0) header.uid = overrides.uid;
  if (overrides.gid !== void 0) header.gid = overrides.gid;
  if (overrides.uname !== void 0) header.uname = overrides.uname;
  if (overrides.gname !== void 0) header.gname = overrides.gname;
  if (overrides.pax) header.pax = Object.assign({}, header.pax ?? {}, overrides.pax);
}
__name(applyOverrides, "applyOverrides");
function getMetaParser(type) {
  switch (type) {
    case "pax-global-header":
    case "pax-header":
      return parsePax;
    case "gnu-long-name":
      return (data) => ({ name: readString(data, 0, data.length) });
    case "gnu-long-link-name":
      return (data) => ({ linkname: readString(data, 0, data.length) });
    default:
      return;
  }
}
__name(getMetaParser, "getMetaParser");
function getHeaderBlocks(header) {
  const base = createTarHeader(header);
  const pax = generatePax(header);
  if (!pax) return [base];
  const paxPadding = -pax.paxBody.length & BLOCK_SIZE_MASK;
  const paddingBlocks = paxPadding > 0 ? [ZERO_BLOCK.subarray(0, paxPadding)] : [];
  return [
    pax.paxHeader,
    pax.paxBody,
    ...paddingBlocks,
    base
  ];
}
__name(getHeaderBlocks, "getHeaderBlocks");
var EOF_BUFFER = new Uint8Array(BLOCK_SIZE * 2);
function createTarPacker(onData, onError, onFinalize) {
  let currentHeader = null;
  let bytesWritten = 0;
  let finalized = false;
  return {
    add(header) {
      if (finalized) {
        const error = /* @__PURE__ */ new Error("No new tar entries after finalize.");
        onError(error);
        throw error;
      }
      if (currentHeader !== null) {
        const error = /* @__PURE__ */ new Error("Previous entry must be completed before adding a new one");
        onError(error);
        throw error;
      }
      try {
        const size = isBodyless(header) ? 0 : header.size ?? 0;
        const headerBlocks = getHeaderBlocks({
          ...header,
          size
        });
        for (const block of headerBlocks) onData(block);
        currentHeader = {
          ...header,
          size
        };
        bytesWritten = 0;
      } catch (error) {
        onError(error);
      }
    },
    write(chunk) {
      if (!currentHeader) {
        const error = /* @__PURE__ */ new Error("No active tar entry.");
        onError(error);
        throw error;
      }
      if (finalized) {
        const error = /* @__PURE__ */ new Error("Cannot write data after finalize.");
        onError(error);
        throw error;
      }
      const newTotal = bytesWritten + chunk.length;
      if (newTotal > currentHeader.size) {
        const error = /* @__PURE__ */ new Error(`"${currentHeader.name}" exceeds given size of ${currentHeader.size} bytes.`);
        onError(error);
        throw error;
      }
      try {
        bytesWritten = newTotal;
        onData(chunk);
      } catch (error) {
        onError(error);
      }
    },
    endEntry() {
      if (!currentHeader) {
        const error = /* @__PURE__ */ new Error("No active entry to end.");
        onError(error);
        throw error;
      }
      if (finalized) {
        const error = /* @__PURE__ */ new Error("Cannot end entry after finalize.");
        onError(error);
        throw error;
      }
      try {
        if (bytesWritten !== currentHeader.size) {
          const error = /* @__PURE__ */ new Error(`Size mismatch for "${currentHeader.name}".`);
          onError(error);
          throw error;
        }
        const paddingSize = -currentHeader.size & BLOCK_SIZE_MASK;
        if (paddingSize > 0) onData(new Uint8Array(paddingSize));
        currentHeader = null;
        bytesWritten = 0;
      } catch (error) {
        onError(error);
        throw error;
      }
    },
    finalize() {
      if (finalized) {
        const error = /* @__PURE__ */ new Error("Archive has already been finalized");
        onError(error);
        throw error;
      }
      if (currentHeader !== null) {
        const error = /* @__PURE__ */ new Error("Cannot finalize while an entry is still active");
        onError(error);
        throw error;
      }
      try {
        onData(EOF_BUFFER);
        finalized = true;
        if (onFinalize) onFinalize();
      } catch (error) {
        onError(error);
      }
    }
  };
}
__name(createTarPacker, "createTarPacker");
var INITIAL_CAPACITY = 256;
function createChunkQueue() {
  let chunks = new Array(INITIAL_CAPACITY);
  let capacityMask = chunks.length - 1;
  let head = 0;
  let tail = 0;
  let totalAvailable = 0;
  const consumeFromHead = /* @__PURE__ */ __name((count) => {
    const chunk = chunks[head];
    if (count === chunk.length) {
      chunks[head] = EMPTY;
      head = head + 1 & capacityMask;
    } else chunks[head] = chunk.subarray(count);
    totalAvailable -= count;
    if (totalAvailable === 0 && chunks.length > INITIAL_CAPACITY) {
      chunks = new Array(INITIAL_CAPACITY);
      capacityMask = INITIAL_CAPACITY - 1;
      head = 0;
      tail = 0;
    }
  }, "consumeFromHead");
  function pull(bytes, callback) {
    if (callback) {
      let fed = 0;
      let remaining$1 = Math.min(bytes, totalAvailable);
      while (remaining$1 > 0) {
        const chunk = chunks[head];
        const toFeed = Math.min(remaining$1, chunk.length);
        const segment = toFeed === chunk.length ? chunk : chunk.subarray(0, toFeed);
        consumeFromHead(toFeed);
        remaining$1 -= toFeed;
        fed += toFeed;
        if (!callback(segment)) break;
      }
      return fed;
    }
    if (totalAvailable < bytes) return null;
    if (bytes === 0) return EMPTY;
    const firstChunk = chunks[head];
    if (firstChunk.length >= bytes) {
      const view = firstChunk.length === bytes ? firstChunk : firstChunk.subarray(0, bytes);
      consumeFromHead(bytes);
      return view;
    }
    const result = new Uint8Array(bytes);
    let copied = 0;
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = chunks[head];
      const toCopy = Math.min(remaining, chunk.length);
      result.set(toCopy === chunk.length ? chunk : chunk.subarray(0, toCopy), copied);
      copied += toCopy;
      remaining -= toCopy;
      consumeFromHead(toCopy);
    }
    return result;
  }
  __name(pull, "pull");
  return {
    push: /* @__PURE__ */ __name((chunk) => {
      if (chunk.length === 0) return;
      let nextTail = tail + 1 & capacityMask;
      if (nextTail === head) {
        const oldLen = chunks.length;
        const newLen = oldLen * 2;
        const newChunks = new Array(newLen);
        const count = tail - head + oldLen & oldLen - 1;
        if (head < tail) for (let i = 0; i < count; i++) newChunks[i] = chunks[head + i];
        else if (count > 0) {
          const firstPart = oldLen - head;
          for (let i = 0; i < firstPart; i++) newChunks[i] = chunks[head + i];
          for (let i = 0; i < tail; i++) newChunks[firstPart + i] = chunks[i];
        }
        chunks = newChunks;
        capacityMask = newLen - 1;
        head = 0;
        tail = count;
        nextTail = tail + 1 & capacityMask;
      }
      chunks[tail] = chunk;
      tail = nextTail;
      totalAvailable += chunk.length;
    }, "push"),
    available: /* @__PURE__ */ __name(() => totalAvailable, "available"),
    peek: /* @__PURE__ */ __name((bytes) => {
      if (totalAvailable < bytes) return null;
      if (bytes === 0) return EMPTY;
      const firstChunk = chunks[head];
      if (firstChunk.length >= bytes) return firstChunk.length === bytes ? firstChunk : firstChunk.subarray(0, bytes);
      const result = new Uint8Array(bytes);
      let copied = 0;
      let index = head;
      while (copied < bytes) {
        const chunk = chunks[index];
        const toCopy = Math.min(bytes - copied, chunk.length);
        if (toCopy === chunk.length) result.set(chunk, copied);
        else result.set(chunk.subarray(0, toCopy), copied);
        copied += toCopy;
        index = index + 1 & capacityMask;
      }
      return result;
    }, "peek"),
    discard: /* @__PURE__ */ __name((bytes) => {
      if (bytes > totalAvailable) throw new Error("Too many bytes consumed");
      if (bytes === 0) return;
      let remaining = bytes;
      while (remaining > 0) {
        const chunk = chunks[head];
        const toConsume = Math.min(remaining, chunk.length);
        consumeFromHead(toConsume);
        remaining -= toConsume;
      }
    }, "discard"),
    pull
  };
}
__name(createChunkQueue, "createChunkQueue");
var STATE_HEADER = 0;
var STATE_BODY = 1;
var truncateErr = /* @__PURE__ */ new Error("Tar archive is truncated.");
function createUnpacker(options = {}) {
  const strict = options.strict ?? false;
  const { available, peek, push, discard, pull } = createChunkQueue();
  let state = STATE_HEADER;
  let ended = false;
  let done = false;
  let eof = false;
  let currentEntry = null;
  const paxGlobals = {};
  let nextEntryOverrides = {};
  const unpacker = {
    isEntryActive: /* @__PURE__ */ __name(() => state === STATE_BODY, "isEntryActive"),
    isBodyComplete: /* @__PURE__ */ __name(() => !currentEntry || currentEntry.remaining === 0, "isBodyComplete"),
    write(chunk) {
      if (ended) throw new Error("Archive already ended.");
      push(chunk);
    },
    end() {
      ended = true;
    },
    readHeader() {
      if (state !== STATE_HEADER) throw new Error("Cannot read header while an entry is active");
      if (done) return void 0;
      while (!done) {
        if (available() < BLOCK_SIZE) {
          if (ended) {
            if (available() > 0 && strict) throw truncateErr;
            done = true;
            return;
          }
          return null;
        }
        const headerBlock = peek(BLOCK_SIZE);
        if (isZeroBlock(headerBlock)) {
          if (available() < BLOCK_SIZE * 2) {
            if (ended) {
              if (strict) throw truncateErr;
              done = true;
              return;
            }
            return null;
          }
          if (isZeroBlock(peek(BLOCK_SIZE * 2).subarray(BLOCK_SIZE))) {
            discard(BLOCK_SIZE * 2);
            done = true;
            eof = true;
            return;
          }
          if (strict) throw new Error("Invalid tar header.");
          discard(BLOCK_SIZE);
          continue;
        }
        let internalHeader;
        try {
          internalHeader = parseUstarHeader(headerBlock, strict);
        } catch (err) {
          if (strict) throw err;
          discard(BLOCK_SIZE);
          continue;
        }
        const metaParser = getMetaParser(internalHeader.type);
        if (metaParser) {
          const paddedSize = internalHeader.size + BLOCK_SIZE_MASK & ~BLOCK_SIZE_MASK;
          if (available() < BLOCK_SIZE + paddedSize) {
            if (ended && strict) throw truncateErr;
            return null;
          }
          discard(BLOCK_SIZE);
          const overrides = metaParser(pull(paddedSize).subarray(0, internalHeader.size));
          const target = internalHeader.type === "pax-global-header" ? paxGlobals : nextEntryOverrides;
          for (const key in overrides) target[key] = overrides[key];
          continue;
        }
        discard(BLOCK_SIZE);
        const header = internalHeader;
        if (internalHeader.prefix) header.name = `${internalHeader.prefix}/${header.name}`;
        applyOverrides(header, paxGlobals);
        applyOverrides(header, nextEntryOverrides);
        nextEntryOverrides = {};
        currentEntry = {
          header,
          remaining: header.size,
          padding: -header.size & BLOCK_SIZE_MASK
        };
        state = STATE_BODY;
        return header;
      }
    },
    streamBody(callback) {
      if (state !== STATE_BODY || !currentEntry || currentEntry.remaining === 0) return 0;
      const bytesToFeed = Math.min(currentEntry.remaining, available());
      if (bytesToFeed === 0) return 0;
      const fed = pull(bytesToFeed, callback);
      currentEntry.remaining -= fed;
      return fed;
    },
    skipPadding() {
      if (state !== STATE_BODY || !currentEntry) return true;
      if (currentEntry.remaining > 0) throw new Error("Body not fully consumed");
      if (available() < currentEntry.padding) return false;
      discard(currentEntry.padding);
      currentEntry = null;
      state = STATE_HEADER;
      return true;
    },
    skipEntry() {
      if (state !== STATE_BODY || !currentEntry) return true;
      const toDiscard = Math.min(currentEntry.remaining, available());
      if (toDiscard > 0) {
        discard(toDiscard);
        currentEntry.remaining -= toDiscard;
      }
      if (currentEntry.remaining > 0) return false;
      return unpacker.skipPadding();
    },
    validateEOF() {
      if (strict) {
        if (!eof) throw truncateErr;
        if (available() > 0) {
          if (pull(available()).some((byte) => byte !== 0)) throw new Error("Invalid EOF.");
        }
      }
    }
  };
  return unpacker;
}
__name(createUnpacker, "createUnpacker");
function isZeroBlock(block) {
  if (block.byteOffset % 8 === 0) {
    const view = new BigUint64Array(block.buffer, block.byteOffset, block.length / 8);
    for (let i = 0; i < view.length; i++) if (view[i] !== 0n) return false;
    return true;
  }
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}
__name(isZeroBlock, "isZeroBlock");
function createGzipEncoder() {
  return new CompressionStream("gzip");
}
__name(createGzipEncoder, "createGzipEncoder");
function createGzipDecoder() {
  return new DecompressionStream("gzip");
}
__name(createGzipDecoder, "createGzipDecoder");
function createTarPacker2() {
  let streamController;
  let packer;
  return {
    readable: new ReadableStream({ start(controller) {
      streamController = controller;
      packer = createTarPacker(controller.enqueue.bind(controller), controller.error.bind(controller), controller.close.bind(controller));
    } }),
    controller: {
      add(header) {
        const bodyless = isBodyless(header);
        const h = { ...header };
        if (bodyless) h.size = 0;
        packer.add(h);
        if (bodyless) packer.endEntry();
        return new WritableStream({
          write(chunk) {
            packer.write(chunk);
          },
          close() {
            if (!bodyless) packer.endEntry();
          },
          abort(reason) {
            streamController.error(reason);
          }
        });
      },
      finalize() {
        packer.finalize();
      },
      error(err) {
        streamController.error(err);
      }
    }
  };
}
__name(createTarPacker2, "createTarPacker");
async function streamToBuffer(stream) {
  const chunks = [];
  const reader = stream.getReader();
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}
__name(streamToBuffer, "streamToBuffer");
var drain = /* @__PURE__ */ __name((stream) => stream.pipeTo(new WritableStream()), "drain");
function createTarDecoder(options = {}) {
  const unpacker = createUnpacker(options);
  let bodyController = null;
  let pumping = false;
  const pump = /* @__PURE__ */ __name((controller) => {
    if (pumping) return;
    pumping = true;
    try {
      while (true) if (unpacker.isEntryActive()) {
        if (bodyController) {
          if (unpacker.streamBody((c) => (bodyController.enqueue(c), true)) === 0 && !unpacker.isBodyComplete()) break;
        } else if (!unpacker.skipEntry()) break;
        if (unpacker.isBodyComplete()) {
          try {
            bodyController?.close();
          } catch {
          }
          bodyController = null;
          if (!unpacker.skipPadding()) break;
        }
      } else {
        const header = unpacker.readHeader();
        if (header === null || header === void 0) break;
        controller.enqueue({
          header,
          body: new ReadableStream({
            start(c) {
              if (header.size === 0) c.close();
              else bodyController = c;
            },
            pull: /* @__PURE__ */ __name(() => pump(controller), "pull"),
            cancel() {
              bodyController = null;
              pump(controller);
            }
          })
        });
      }
    } catch (error) {
      try {
        bodyController?.error(error);
      } catch {
      }
      bodyController = null;
      throw error;
    } finally {
      pumping = false;
    }
  }, "pump");
  return new TransformStream({
    transform(chunk, controller) {
      try {
        unpacker.write(chunk);
        pump(controller);
      } catch (error) {
        try {
          bodyController?.error(error);
        } catch {
        }
        throw error;
      }
    },
    flush(controller) {
      try {
        unpacker.end();
        pump(controller);
        unpacker.validateEOF();
        if (unpacker.isEntryActive() && !unpacker.isBodyComplete()) try {
          bodyController?.close();
        } catch {
        }
      } catch (error) {
        try {
          bodyController?.error(error);
        } catch {
        }
        throw error;
      }
    }
  }, void 0, { highWaterMark: 1 });
}
__name(createTarDecoder, "createTarDecoder");
async function packTar(entries) {
  const { readable, controller } = createTarPacker2();
  await (async () => {
    for (const entry of entries) {
      const entryStream = controller.add(entry.header);
      const body = "body" in entry ? entry.body : entry.data;
      if (!body) {
        await entryStream.close();
        continue;
      }
      if (body instanceof ReadableStream) await body.pipeTo(entryStream);
      else if (body instanceof Blob) await body.stream().pipeTo(entryStream);
      else try {
        const chunk = await normalizeBody(body);
        if (chunk.length > 0) {
          const writer = entryStream.getWriter();
          await writer.write(chunk);
          await writer.close();
        } else await entryStream.close();
      } catch {
        throw new TypeError(`Unsupported content type for entry "${entry.header.name}".`);
      }
    }
  })().then(() => controller.finalize()).catch((err) => controller.error(err));
  return new Uint8Array(await streamToBuffer(readable));
}
__name(packTar, "packTar");
async function unpackTar(archive, options = {}) {
  const sourceStream = archive instanceof ReadableStream ? archive : new ReadableStream({ start(controller) {
    controller.enqueue(archive instanceof Uint8Array ? archive : new Uint8Array(archive));
    controller.close();
  } });
  const results = [];
  const entryStream = sourceStream.pipeThrough(createTarDecoder(options));
  for await (const entry of entryStream) {
    let processedHeader;
    try {
      processedHeader = transformHeader(entry.header, options);
    } catch (error) {
      await entry.body.cancel();
      throw error;
    }
    if (processedHeader === null) {
      await drain(entry.body);
      continue;
    }
    if (isBodyless(processedHeader)) {
      await drain(entry.body);
      results.push({ header: processedHeader });
    } else results.push({
      header: processedHeader,
      data: await streamToBuffer(entry.body)
    });
  }
  return results;
}
__name(unpackTar, "unpackTar");
var lzma = null;
var lzmaLoadError = null;
async function getLzma() {
  if (lzma)
    return lzma;
  if (lzmaLoadError)
    throw lzmaLoadError;
  try {
    lzma = await import("../_libs/node-liblzma.mjs");
    return lzma;
  } catch {
    lzmaLoadError = new Error("xz compression requires node-liblzma which failed to load. Install liblzma-dev (apt) or xz (brew) and reinstall dependencies.");
    throw lzmaLoadError;
  }
}
__name(getLzma, "getLzma");
var MAX_ARCHIVE_SIZE = 100 * 1024 * 1024;
var MAX_ENTRIES = 1e4;
function toModernTarEntry(entry) {
  let type = "file";
  if (entry.isDirectory) {
    type = "directory";
  } else if (entry.isSymlink) {
    type = "symlink";
  }
  let name = entry.name;
  if (entry.isDirectory && !name.endsWith("/")) {
    name += "/";
  }
  let body;
  if (entry.content !== void 0) {
    if (typeof entry.content === "string") {
      body = new TextEncoder().encode(entry.content);
    } else {
      body = entry.content;
    }
  }
  const size = entry.isDirectory || entry.isSymlink ? 0 : body?.length ?? 0;
  return {
    header: {
      name,
      mode: entry.mode ?? (entry.isDirectory ? 493 : 420),
      uid: entry.uid ?? 0,
      gid: entry.gid ?? 0,
      size,
      mtime: entry.mtime ?? /* @__PURE__ */ new Date(),
      type,
      linkname: entry.linkTarget ?? "",
      uname: "user",
      gname: "user"
    },
    body
  };
}
__name(toModernTarEntry, "toModernTarEntry");
async function createArchive(entries) {
  const modernEntries = entries.map(toModernTarEntry);
  return packTar(modernEntries);
}
__name(createArchive, "createArchive");
async function createCompressedArchive(entries) {
  const tarBuffer = await createArchive(entries);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(tarBuffer);
      controller.close();
    }
  });
  const compressedStream = stream.pipeThrough(createGzipEncoder());
  const reader = compressedStream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
__name(createCompressedArchive, "createCompressedArchive");
async function parseArchive(data) {
  if (data.length > MAX_ARCHIVE_SIZE) {
    return {
      entries: [],
      error: `Archive too large (max ${MAX_ARCHIVE_SIZE} bytes)`
    };
  }
  try {
    const modernEntries = await unpackTar(data);
    const entries = [];
    for (const entry of modernEntries) {
      if (entries.length >= MAX_ENTRIES) {
        return { entries, error: `Too many entries (max ${MAX_ENTRIES})` };
      }
      let type = "file";
      switch (entry.header.type) {
        case "directory":
          type = "directory";
          break;
        case "symlink":
          type = "symlink";
          break;
        case "link":
          type = "hardlink";
          break;
        case "file":
          type = "file";
          break;
        default:
          type = "other";
      }
      entries.push({
        name: entry.header.name,
        mode: entry.header.mode ?? 420,
        uid: entry.header.uid ?? 0,
        gid: entry.header.gid ?? 0,
        size: entry.header.size,
        mtime: entry.header.mtime ?? /* @__PURE__ */ new Date(),
        type,
        linkTarget: entry.header.linkname || void 0,
        content: entry.data ?? new Uint8Array(0)
      });
    }
    return { entries };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { entries: [], error: msg };
  }
}
__name(parseArchive, "parseArchive");
async function parseCompressedArchive(data) {
  if (data.length > MAX_ARCHIVE_SIZE) {
    return {
      entries: [],
      error: `Archive too large (max ${MAX_ARCHIVE_SIZE} bytes)`
    };
  }
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      }
    });
    const decompressedStream = stream.pipeThrough(createGzipDecoder());
    const reader = decompressedStream.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const tarBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      tarBuffer.set(chunk, offset);
      offset += chunk.length;
    }
    return parseArchive(tarBuffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { entries: [], error: `Decompression failed: ${msg}` };
  }
}
__name(parseCompressedArchive, "parseCompressedArchive");
function isGzipCompressed(data) {
  return data.length >= 2 && data[0] === 31 && data[1] === 139;
}
__name(isGzipCompressed, "isGzipCompressed");
function isBzip2Compressed(data) {
  return data.length >= 3 && data[0] === 66 && data[1] === 90 && data[2] === 104;
}
__name(isBzip2Compressed, "isBzip2Compressed");
function isXzCompressed(data) {
  return data.length >= 6 && data[0] === 253 && data[1] === 55 && data[2] === 122 && data[3] === 88 && data[4] === 90 && data[5] === 0;
}
__name(isXzCompressed, "isXzCompressed");
async function decompressBzip2(data) {
  const Bzip2 = compressjs.Bzip2;
  const decompressed = Bzip2.decompressFile(Array.from(data));
  return new Uint8Array(decompressed);
}
__name(decompressBzip2, "decompressBzip2");
async function compressBzip2(data) {
  const Bzip2 = compressjs.Bzip2;
  const output = [];
  Bzip2.compressFile(Array.from(data), output, 9);
  return new Uint8Array(output);
}
__name(compressBzip2, "compressBzip2");
async function decompressXz(data) {
  const lzmaModule = await getLzma();
  const decompressed = lzmaModule.unxzSync(Buffer.from(data));
  return new Uint8Array(decompressed);
}
__name(decompressXz, "decompressXz");
async function compressXz(data) {
  const lzmaModule = await getLzma();
  const compressed = lzmaModule.xzSync(Buffer.from(data));
  return new Uint8Array(compressed);
}
__name(compressXz, "compressXz");
async function createBzip2CompressedArchive(entries) {
  const tarBuffer = await createArchive(entries);
  return compressBzip2(tarBuffer);
}
__name(createBzip2CompressedArchive, "createBzip2CompressedArchive");
async function createXzCompressedArchive(entries) {
  const tarBuffer = await createArchive(entries);
  return compressXz(tarBuffer);
}
__name(createXzCompressedArchive, "createXzCompressedArchive");
async function parseBzip2CompressedArchive(data) {
  if (data.length > MAX_ARCHIVE_SIZE) {
    return {
      entries: [],
      error: `Archive too large (max ${MAX_ARCHIVE_SIZE} bytes)`
    };
  }
  try {
    const tarBuffer = await decompressBzip2(data);
    return parseArchive(tarBuffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { entries: [], error: msg };
  }
}
__name(parseBzip2CompressedArchive, "parseBzip2CompressedArchive");
async function parseXzCompressedArchive(data) {
  if (data.length > MAX_ARCHIVE_SIZE) {
    return {
      entries: [],
      error: `Archive too large (max ${MAX_ARCHIVE_SIZE} bytes)`
    };
  }
  try {
    const tarBuffer = await decompressXz(data);
    return parseArchive(tarBuffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { entries: [], error: msg };
  }
}
__name(parseXzCompressedArchive, "parseXzCompressedArchive");
function isZstdCompressed(data) {
  return data.length >= 4 && data[0] === 40 && data[1] === 181 && data[2] === 47 && data[3] === 253;
}
__name(isZstdCompressed, "isZstdCompressed");
async function compressZstd(data) {
  const compressed = await libExports.compress(Buffer.from(data), 3);
  return new Uint8Array(compressed);
}
__name(compressZstd, "compressZstd");
async function decompressZstd(data) {
  const decompressed = await libExports.decompress(Buffer.from(data));
  return new Uint8Array(decompressed);
}
__name(decompressZstd, "decompressZstd");
async function createZstdCompressedArchive(entries) {
  const tarBuffer = await createArchive(entries);
  return compressZstd(tarBuffer);
}
__name(createZstdCompressedArchive, "createZstdCompressedArchive");
async function parseZstdCompressedArchive(data) {
  if (data.length > MAX_ARCHIVE_SIZE) {
    return {
      entries: [],
      error: `Archive too large (max ${MAX_ARCHIVE_SIZE} bytes)`
    };
  }
  try {
    const tarBuffer = await decompressZstd(data);
    return parseArchive(tarBuffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { entries: [], error: msg };
  }
}
__name(parseZstdCompressedArchive, "parseZstdCompressedArchive");
function parseOptions(args) {
  const options = {
    create: false,
    append: false,
    update: false,
    extract: false,
    list: false,
    file: "",
    autoCompress: false,
    gzip: false,
    bzip2: false,
    xz: false,
    zstd: false,
    verbose: false,
    toStdout: false,
    keepOldFiles: false,
    touch: false,
    directory: "",
    preserve: false,
    strip: 0,
    exclude: [],
    filesFrom: "",
    excludeFrom: "",
    wildcards: false
  };
  const files = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2) {
      if (/^-\d+$/.test(arg)) {
        files.push(arg);
        i++;
        continue;
      }
      for (let j = 1; j < arg.length; j++) {
        const char = arg[j];
        switch (char) {
          case "c":
            options.create = true;
            break;
          case "r":
            options.append = true;
            break;
          case "u":
            options.update = true;
            break;
          case "x":
            options.extract = true;
            break;
          case "t":
            options.list = true;
            break;
          case "a":
            options.autoCompress = true;
            break;
          case "z":
            options.gzip = true;
            break;
          case "j":
            options.bzip2 = true;
            break;
          case "J":
            options.xz = true;
            break;
          case "v":
            options.verbose = true;
            break;
          case "O":
            options.toStdout = true;
            break;
          case "k":
            options.keepOldFiles = true;
            break;
          case "m":
            options.touch = true;
            break;
          case "p":
            options.preserve = true;
            break;
          case "f":
            if (j < arg.length - 1) {
              options.file = arg.substring(j + 1);
              j = arg.length;
            } else {
              i++;
              if (i >= args.length) {
                return {
                  ok: false,
                  error: {
                    stdout: "",
                    stderr: "tar: option requires an argument -- 'f'\n",
                    exitCode: 2
                  }
                };
              }
              options.file = args[i];
            }
            break;
          case "C":
            if (j < arg.length - 1) {
              options.directory = arg.substring(j + 1);
              j = arg.length;
            } else {
              i++;
              if (i >= args.length) {
                return {
                  ok: false,
                  error: {
                    stdout: "",
                    stderr: "tar: option requires an argument -- 'C'\n",
                    exitCode: 2
                  }
                };
              }
              options.directory = args[i];
            }
            break;
          case "T":
            if (j < arg.length - 1) {
              options.filesFrom = arg.substring(j + 1);
              j = arg.length;
            } else {
              i++;
              if (i >= args.length) {
                return {
                  ok: false,
                  error: {
                    stdout: "",
                    stderr: "tar: option requires an argument -- 'T'\n",
                    exitCode: 2
                  }
                };
              }
              options.filesFrom = args[i];
            }
            break;
          case "X":
            if (j < arg.length - 1) {
              options.excludeFrom = arg.substring(j + 1);
              j = arg.length;
            } else {
              i++;
              if (i >= args.length) {
                return {
                  ok: false,
                  error: {
                    stdout: "",
                    stderr: "tar: option requires an argument -- 'X'\n",
                    exitCode: 2
                  }
                };
              }
              options.excludeFrom = args[i];
            }
            break;
          default:
            return { ok: false, error: unknownOption("tar", `-${char}`) };
        }
      }
      i++;
      continue;
    }
    if (arg === "-c" || arg === "--create") {
      options.create = true;
    } else if (arg === "-r" || arg === "--append") {
      options.append = true;
    } else if (arg === "-u" || arg === "--update") {
      options.update = true;
    } else if (arg === "-x" || arg === "--extract" || arg === "--get") {
      options.extract = true;
    } else if (arg === "-t" || arg === "--list") {
      options.list = true;
    } else if (arg === "-a" || arg === "--auto-compress") {
      options.autoCompress = true;
    } else if (arg === "-z" || arg === "--gzip" || arg === "--gunzip") {
      options.gzip = true;
    } else if (arg === "-j" || arg === "--bzip2") {
      options.bzip2 = true;
    } else if (arg === "-J" || arg === "--xz") {
      options.xz = true;
    } else if (arg === "--zstd") {
      options.zstd = true;
    } else if (arg === "-v" || arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "-O" || arg === "--to-stdout") {
      options.toStdout = true;
    } else if (arg === "-k" || arg === "--keep-old-files") {
      options.keepOldFiles = true;
    } else if (arg === "-m" || arg === "--touch") {
      options.touch = true;
    } else if (arg === "--wildcards") {
      options.wildcards = true;
    } else if (arg === "-p" || arg === "--preserve" || arg === "--preserve-permissions") {
      options.preserve = true;
    } else if (arg === "-f" || arg === "--file") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option requires an argument -- 'f'\n",
            exitCode: 2
          }
        };
      }
      options.file = args[i];
    } else if (arg.startsWith("--file=")) {
      options.file = arg.substring(7);
    } else if (arg === "-C" || arg === "--directory") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option requires an argument -- 'C'\n",
            exitCode: 2
          }
        };
      }
      options.directory = args[i];
    } else if (arg.startsWith("--directory=")) {
      options.directory = arg.substring(12);
    } else if (arg.startsWith("--strip-components=") || arg.startsWith("--strip=")) {
      const val = arg.includes("--strip-components=") ? arg.substring(19) : arg.substring(8);
      const num = parseInt(val, 10);
      if (Number.isNaN(num) || num < 0) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: `tar: invalid number for --strip: '${val}'
`,
            exitCode: 2
          }
        };
      }
      options.strip = num;
    } else if (arg.startsWith("--exclude=")) {
      options.exclude.push(arg.substring(10));
    } else if (arg === "--exclude") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option '--exclude' requires an argument\n",
            exitCode: 2
          }
        };
      }
      options.exclude.push(args[i]);
    } else if (arg === "-T" || arg === "--files-from") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option requires an argument -- 'T'\n",
            exitCode: 2
          }
        };
      }
      options.filesFrom = args[i];
    } else if (arg.startsWith("--files-from=")) {
      options.filesFrom = arg.substring(13);
    } else if (arg === "-X" || arg === "--exclude-from") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option requires an argument -- 'X'\n",
            exitCode: 2
          }
        };
      }
      options.excludeFrom = args[i];
    } else if (arg.startsWith("--exclude-from=")) {
      options.excludeFrom = arg.substring(15);
    } else if (arg === "--") {
      files.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith("-")) {
      return { ok: false, error: unknownOption("tar", arg) };
    } else {
      files.push(arg);
    }
    i++;
  }
  return { ok: true, options, files };
}
__name(parseOptions, "parseOptions");
var BATCH_SIZE = 100;
var tarHelp = {
  name: "tar",
  summary: "manipulate tape archives",
  usage: "tar [options] [file...]",
  description: [
    "Create, extract, or list contents of tar archives.",
    "",
    "One of -c, -r, -u, -x, or -t is required to specify the operation."
  ],
  options: [
    "-c, --create           create a new archive",
    "-r, --append           append files to the end of an archive",
    "-u, --update           only append files newer than copy in archive",
    "-x, --extract          extract files from an archive",
    "-t, --list             list contents of an archive",
    "-f, --file=ARCHIVE     use archive file ARCHIVE",
    "-a, --auto-compress    use archive suffix to determine compression",
    "-z, --gzip             filter archive through gzip",
    "-j, --bzip2            filter archive through bzip2",
    "-J, --xz               filter archive through xz",
    "--zstd                 filter archive through zstd",
    "-v, --verbose          verbosely list files processed",
    "-O, --to-stdout        extract files to standard output",
    "-k, --keep-old-files   don't replace existing files when extracting",
    "-m, --touch            don't extract file modified time",
    "-C, --directory=DIR    change to directory DIR before performing operations",
    "-p, --preserve         preserve permissions",
    "-T, --files-from=FILE  read files to extract/create from FILE",
    "-X, --exclude-from=FILE read exclude patterns from FILE",
    "--strip=N              strip N leading path components on extraction",
    "--exclude=PATTERN      exclude files matching PATTERN",
    "--wildcards            use wildcards for pattern matching",
    "    --help             display this help and exit"
  ],
  examples: [
    "tar -cvf archive.tar file1 file2     Create archive from files",
    "tar -czvf archive.tar.gz dir/        Create gzip-compressed archive",
    "tar -cjvf archive.tar.bz2 dir/       Create bzip2-compressed archive",
    "tar -rf archive.tar newfile.txt      Append file to archive",
    "tar -uf archive.tar dir/             Update archive with newer files",
    "tar -xvf archive.tar                 Extract archive",
    "tar -xvf archive.tar -C /tmp         Extract to /tmp",
    "tar -tvf archive.tar                 List archive contents",
    "tar -xzf archive.tar.gz              Extract gzip archive",
    "tar -xf archive.tar file1.txt        Extract specific file",
    "tar -xOf archive.tar file.txt        Extract file to stdout",
    "tar -xf archive.tar --wildcards '*.txt'  Extract matching files"
  ]
};
function matchesExclude(path, patterns) {
  const basename = path.includes("/") ? path.substring(path.lastIndexOf("/") + 1) : path;
  for (const pattern of patterns) {
    const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "<<<GLOBSTAR>>>").replace(/\*/g, "[^/]*").replace(/<<<GLOBSTAR>>>/g, ".*").replace(/\?/g, ".");
    if (new RegExp(`^${regex}$`).test(path) || new RegExp(`^${regex}/`).test(path)) {
      return true;
    }
    if (!pattern.includes("/") && new RegExp(`^${regex}$`).test(basename)) {
      return true;
    }
  }
  return false;
}
__name(matchesExclude, "matchesExclude");
function matchesWildcard(name, pattern) {
  const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "<<<GLOBSTAR>>>").replace(/\*/g, "[^/]*").replace(/<<<GLOBSTAR>>>/g, ".*").replace(/\?/g, ".");
  const basename = name.includes("/") ? name.substring(name.lastIndexOf("/") + 1) : name;
  return new RegExp(`^${regex}$`).test(name) || new RegExp(`^${regex}$`).test(basename);
}
__name(matchesWildcard, "matchesWildcard");
function stripComponents(path, count) {
  if (count <= 0)
    return path;
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.length <= count)
    return "";
  return parts.slice(count).join("/");
}
__name(stripComponents, "stripComponents");
function formatMode(mode, isDir) {
  const chars = isDir ? "d" : "-";
  const perms = [
    mode & 256 ? "r" : "-",
    mode & 128 ? "w" : "-",
    mode & 64 ? "x" : "-",
    mode & 32 ? "r" : "-",
    mode & 16 ? "w" : "-",
    mode & 8 ? "x" : "-",
    mode & 4 ? "r" : "-",
    mode & 2 ? "w" : "-",
    mode & 1 ? "x" : "-"
  ].join("");
  return chars + perms;
}
__name(formatMode, "formatMode");
function formatDate(date) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, " ");
  const hours = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");
  return `${month} ${day} ${hours}:${mins}`;
}
__name(formatDate, "formatDate");
async function collectFiles(ctx, basePath, relativePath, exclude) {
  const entries = [];
  const errors = [];
  const fullPath = ctx.fs.resolvePath(basePath, relativePath);
  try {
    const stat = await ctx.fs.stat(fullPath);
    if (matchesExclude(relativePath, exclude)) {
      return { entries, errors };
    }
    if (stat.isDirectory) {
      entries.push({
        name: relativePath,
        isDirectory: true,
        mode: stat.mode,
        mtime: stat.mtime
      });
      const items = await ctx.fs.readdir(fullPath);
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map((item) => collectFiles(ctx, basePath, relativePath ? `${relativePath}/${item}` : item, exclude)));
        for (const result of results) {
          entries.push(...result.entries);
          errors.push(...result.errors);
        }
      }
    } else if (stat.isFile) {
      const content = await ctx.fs.readFileBuffer(fullPath);
      entries.push({
        name: relativePath,
        content,
        mode: stat.mode,
        mtime: stat.mtime
      });
    } else if (stat.isSymbolicLink) {
      const target = await ctx.fs.readlink(fullPath);
      entries.push({
        name: relativePath,
        isSymlink: true,
        linkTarget: target,
        mode: stat.mode,
        mtime: stat.mtime
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    errors.push(`tar: ${relativePath}: ${msg}`);
  }
  return { entries, errors };
}
__name(collectFiles, "collectFiles");
async function createTarArchive(ctx, options, files) {
  if (files.length === 0) {
    return {
      stdout: "",
      stderr: "tar: Cowardly refusing to create an empty archive\n",
      exitCode: 2
    };
  }
  const workDir = options.directory ? ctx.fs.resolvePath(ctx.cwd, options.directory) : ctx.cwd;
  const allEntries = [];
  const allErrors = [];
  let verboseOutput = "";
  for (const file of files) {
    const { entries, errors } = await collectFiles(ctx, workDir, file, options.exclude);
    allEntries.push(...entries);
    allErrors.push(...errors);
    if (options.verbose) {
      for (const entry of entries) {
        verboseOutput += `${entry.name}${entry.isDirectory ? "/" : ""}
`;
      }
    }
  }
  if (allEntries.length === 0 && allErrors.length > 0) {
    return {
      stdout: "",
      stderr: `${allErrors.join("\n")}
`,
      exitCode: 2
    };
  }
  let archiveData;
  try {
    if (options.gzip) {
      archiveData = await createCompressedArchive(allEntries);
    } else if (options.bzip2) {
      archiveData = await createBzip2CompressedArchive(allEntries);
    } else if (options.xz) {
      archiveData = await createXzCompressedArchive(allEntries);
    } else if (options.zstd) {
      archiveData = await createZstdCompressedArchive(allEntries);
    } else {
      archiveData = await createArchive(allEntries);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: error creating archive: ${msg}
`,
      exitCode: 2
    };
  }
  let stdout = "";
  if (options.file && options.file !== "-") {
    const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);
    try {
      await ctx.fs.writeFile(archivePath, archiveData);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      return {
        stdout: "",
        stderr: `tar: ${options.file}: ${msg}
`,
        exitCode: 2
      };
    }
  } else {
    stdout = String.fromCharCode(...archiveData);
  }
  let stderr = verboseOutput;
  if (allErrors.length > 0) {
    stderr += `${allErrors.join("\n")}
`;
  }
  return { stdout, stderr, exitCode: allErrors.length > 0 ? 2 : 0 };
}
__name(createTarArchive, "createTarArchive");
async function appendTarArchive(ctx, options, files) {
  if (!options.file || options.file === "-") {
    return {
      stdout: "",
      stderr: "tar: Cannot append to stdin/stdout\n",
      exitCode: 2
    };
  }
  if (files.length === 0) {
    return {
      stdout: "",
      stderr: "tar: Cowardly refusing to append nothing to archive\n",
      exitCode: 2
    };
  }
  const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);
  let existingData;
  try {
    existingData = await ctx.fs.readFileBuffer(archivePath);
  } catch {
    return {
      stdout: "",
      stderr: `tar: ${options.file}: Cannot open: No such file or directory
`,
      exitCode: 2
    };
  }
  const parseResult = await parseArchive(existingData);
  if (parseResult.error) {
    return {
      stdout: "",
      stderr: `tar: ${parseResult.error}
`,
      exitCode: 2
    };
  }
  const existingEntries = parseResult.entries.map((e) => ({
    name: e.name,
    content: e.content,
    mode: e.mode,
    mtime: e.mtime,
    isDirectory: e.type === "directory",
    isSymlink: e.type === "symlink",
    linkTarget: e.linkTarget,
    uid: e.uid,
    gid: e.gid
  }));
  const workDir = options.directory ? ctx.fs.resolvePath(ctx.cwd, options.directory) : ctx.cwd;
  const newEntries = [];
  const allErrors = [];
  let verboseOutput = "";
  for (const file of files) {
    const { entries, errors } = await collectFiles(ctx, workDir, file, options.exclude);
    newEntries.push(...entries);
    allErrors.push(...errors);
    if (options.verbose) {
      for (const entry of entries) {
        verboseOutput += `${entry.name}${entry.isDirectory ? "/" : ""}
`;
      }
    }
  }
  const allEntries = [...existingEntries, ...newEntries];
  let archiveData;
  try {
    archiveData = await createArchive(allEntries);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: error creating archive: ${msg}
`,
      exitCode: 2
    };
  }
  try {
    await ctx.fs.writeFile(archivePath, archiveData);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: ${options.file}: ${msg}
`,
      exitCode: 2
    };
  }
  let stderr = verboseOutput;
  if (allErrors.length > 0) {
    stderr += `${allErrors.join("\n")}
`;
  }
  return { stdout: "", stderr, exitCode: allErrors.length > 0 ? 2 : 0 };
}
__name(appendTarArchive, "appendTarArchive");
async function updateTarArchive(ctx, options, files) {
  if (!options.file || options.file === "-") {
    return {
      stdout: "",
      stderr: "tar: Cannot update stdin/stdout\n",
      exitCode: 2
    };
  }
  if (files.length === 0) {
    return {
      stdout: "",
      stderr: "tar: Cowardly refusing to update with nothing\n",
      exitCode: 2
    };
  }
  const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);
  let existingData;
  try {
    existingData = await ctx.fs.readFileBuffer(archivePath);
  } catch {
    return {
      stdout: "",
      stderr: `tar: ${options.file}: Cannot open: No such file or directory
`,
      exitCode: 2
    };
  }
  const parseResult = await parseArchive(existingData);
  if (parseResult.error) {
    return {
      stdout: "",
      stderr: `tar: ${parseResult.error}
`,
      exitCode: 2
    };
  }
  const existingMtimes = /* @__PURE__ */ new Map();
  for (const entry of parseResult.entries) {
    existingMtimes.set(entry.name, entry.mtime);
  }
  const workDir = options.directory ? ctx.fs.resolvePath(ctx.cwd, options.directory) : ctx.cwd;
  const newEntries = [];
  const allErrors = [];
  let verboseOutput = "";
  for (const file of files) {
    const { entries, errors } = await collectFiles(ctx, workDir, file, options.exclude);
    allErrors.push(...errors);
    for (const entry of entries) {
      const existingMtime = existingMtimes.get(entry.name);
      if (!existingMtime || entry.mtime && entry.mtime.getTime() > existingMtime.getTime()) {
        newEntries.push(entry);
        if (options.verbose) {
          verboseOutput += `${entry.name}${entry.isDirectory ? "/" : ""}
`;
        }
      }
    }
  }
  if (newEntries.length === 0) {
    let stderr2 = "";
    if (allErrors.length > 0) {
      stderr2 = `${allErrors.join("\n")}
`;
    }
    return { stdout: "", stderr: stderr2, exitCode: allErrors.length > 0 ? 2 : 0 };
  }
  const updatedNames = new Set(newEntries.map((e) => e.name));
  const existingEntries = parseResult.entries.filter((e) => !updatedNames.has(e.name)).map((e) => ({
    name: e.name,
    content: e.content,
    mode: e.mode,
    mtime: e.mtime,
    isDirectory: e.type === "directory",
    isSymlink: e.type === "symlink",
    linkTarget: e.linkTarget,
    uid: e.uid,
    gid: e.gid
  }));
  const allEntries = [...existingEntries, ...newEntries];
  let archiveData;
  try {
    archiveData = await createArchive(allEntries);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: error creating archive: ${msg}
`,
      exitCode: 2
    };
  }
  try {
    await ctx.fs.writeFile(archivePath, archiveData);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: ${options.file}: ${msg}
`,
      exitCode: 2
    };
  }
  let stderr = verboseOutput;
  if (allErrors.length > 0) {
    stderr += `${allErrors.join("\n")}
`;
  }
  return { stdout: "", stderr, exitCode: allErrors.length > 0 ? 2 : 0 };
}
__name(updateTarArchive, "updateTarArchive");
async function extractTarArchive(ctx, options, specificFiles) {
  let archiveData;
  if (options.file && options.file !== "-") {
    const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);
    try {
      archiveData = await ctx.fs.readFileBuffer(archivePath);
    } catch {
      return {
        stdout: "",
        stderr: `tar: ${options.file}: Cannot open: No such file or directory
`,
        exitCode: 2
      };
    }
  } else {
    archiveData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
  }
  let parseResult;
  const useGzip = options.gzip || isGzipCompressed(archiveData);
  const useBzip2 = options.bzip2 || isBzip2Compressed(archiveData);
  const useXz = options.xz || isXzCompressed(archiveData);
  const useZstd = options.zstd || isZstdCompressed(archiveData);
  if (useGzip) {
    parseResult = await parseCompressedArchive(archiveData);
  } else if (useBzip2) {
    parseResult = await parseBzip2CompressedArchive(archiveData);
  } else if (useXz) {
    parseResult = await parseXzCompressedArchive(archiveData);
  } else if (useZstd) {
    parseResult = await parseZstdCompressedArchive(archiveData);
  } else {
    parseResult = await parseArchive(archiveData);
  }
  if (parseResult.error) {
    return {
      stdout: "",
      stderr: `tar: ${parseResult.error}
`,
      exitCode: 2
    };
  }
  const workDir = options.directory ? ctx.fs.resolvePath(ctx.cwd, options.directory) : ctx.cwd;
  let verboseOutput = "";
  let stdoutContent = "";
  const errors = [];
  if (options.directory && !options.toStdout) {
    try {
      await ctx.fs.mkdir(workDir, { recursive: true });
    } catch {
    }
  }
  for (const entry of parseResult.entries) {
    const name = stripComponents(entry.name, options.strip);
    if (!name)
      continue;
    const displayName = name.endsWith("/") ? name.slice(0, -1) : name;
    if (specificFiles.length > 0) {
      let matches;
      if (options.wildcards) {
        matches = specificFiles.some((f) => matchesWildcard(name, f) || matchesWildcard(displayName, f) || name.startsWith(`${f}/`));
      } else {
        matches = specificFiles.some((f) => name === f || name.startsWith(`${f}/`) || displayName === f);
      }
      if (!matches)
        continue;
    }
    if (matchesExclude(name, options.exclude))
      continue;
    const targetPath = ctx.fs.resolvePath(workDir, name);
    try {
      if (entry.type === "directory") {
        if (options.toStdout)
          continue;
        await ctx.fs.mkdir(targetPath, { recursive: true });
        if (options.verbose) {
          verboseOutput += `${name}
`;
        }
      } else if (entry.type === "file") {
        if (options.toStdout) {
          stdoutContent += new TextDecoder().decode(entry.content);
          if (options.verbose) {
            verboseOutput += `${name}
`;
          }
          continue;
        }
        if (options.keepOldFiles) {
          try {
            await ctx.fs.stat(targetPath);
            if (options.verbose) {
              verboseOutput += `${name}: not overwritten, file exists
`;
            }
            continue;
          } catch {
          }
        }
        const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        if (parentDir) {
          try {
            await ctx.fs.mkdir(parentDir, { recursive: true });
          } catch {
          }
        }
        await ctx.fs.writeFile(targetPath, entry.content);
        if (options.preserve && entry.mode) {
          try {
            await ctx.fs.chmod(targetPath, entry.mode);
          } catch {
          }
        }
        if (options.verbose) {
          verboseOutput += `${name}
`;
        }
      } else if (entry.type === "symlink" && entry.linkTarget) {
        if (options.toStdout)
          continue;
        if (options.keepOldFiles) {
          try {
            await ctx.fs.stat(targetPath);
            if (options.verbose) {
              verboseOutput += `${name}: not overwritten, file exists
`;
            }
            continue;
          } catch {
          }
        }
        const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        if (parentDir) {
          try {
            await ctx.fs.mkdir(parentDir, { recursive: true });
          } catch {
          }
        }
        try {
          await ctx.fs.symlink(entry.linkTarget, targetPath);
        } catch {
        }
        if (options.verbose) {
          verboseOutput += `${name}
`;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      errors.push(`tar: ${name}: ${msg}`);
    }
  }
  let stderr = verboseOutput;
  if (errors.length > 0) {
    stderr += `${errors.join("\n")}
`;
  }
  return { stdout: stdoutContent, stderr, exitCode: errors.length > 0 ? 2 : 0 };
}
__name(extractTarArchive, "extractTarArchive");
async function listTarArchive(ctx, options, specificFiles) {
  let archiveData;
  if (options.file && options.file !== "-") {
    const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);
    try {
      archiveData = await ctx.fs.readFileBuffer(archivePath);
    } catch {
      return {
        stdout: "",
        stderr: `tar: ${options.file}: Cannot open: No such file or directory
`,
        exitCode: 2
      };
    }
  } else {
    archiveData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
  }
  let parseResult;
  const useGzip = options.gzip || isGzipCompressed(archiveData);
  const useBzip2 = options.bzip2 || isBzip2Compressed(archiveData);
  const useXz = options.xz || isXzCompressed(archiveData);
  const useZstd = options.zstd || isZstdCompressed(archiveData);
  if (useGzip) {
    parseResult = await parseCompressedArchive(archiveData);
  } else if (useBzip2) {
    parseResult = await parseBzip2CompressedArchive(archiveData);
  } else if (useXz) {
    parseResult = await parseXzCompressedArchive(archiveData);
  } else if (useZstd) {
    parseResult = await parseZstdCompressedArchive(archiveData);
  } else {
    parseResult = await parseArchive(archiveData);
  }
  if (parseResult.error) {
    return {
      stdout: "",
      stderr: `tar: ${parseResult.error}
`,
      exitCode: 2
    };
  }
  let stdout = "";
  for (const entry of parseResult.entries) {
    const name = stripComponents(entry.name, options.strip);
    if (!name)
      continue;
    const displayName = name.endsWith("/") ? name.slice(0, -1) : name;
    if (specificFiles.length > 0) {
      let matches;
      if (options.wildcards) {
        matches = specificFiles.some((f) => matchesWildcard(name, f) || matchesWildcard(displayName, f) || name.startsWith(`${f}/`));
      } else {
        matches = specificFiles.some((f) => name === f || name.startsWith(`${f}/`) || displayName === f);
      }
      if (!matches)
        continue;
    }
    if (matchesExclude(name, options.exclude))
      continue;
    if (options.verbose) {
      const isDir = entry.type === "directory";
      const mode = formatMode(entry.mode, isDir);
      const owner = `${entry.uid}/${entry.gid}`;
      const size = entry.size.toString().padStart(8, " ");
      const date = formatDate(entry.mtime);
      let line = `${mode} ${owner.padEnd(10)} ${size} ${date} ${name}`;
      if (entry.type === "symlink" && entry.linkTarget) {
        line += ` -> ${entry.linkTarget}`;
      }
      stdout += `${line}
`;
    } else {
      stdout += `${name}
`;
    }
  }
  return { stdout, stderr: "", exitCode: 0 };
}
__name(listTarArchive, "listTarArchive");
var tarCommand = {
  name: "tar",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(tarHelp);
    }
    const parsed = parseOptions(args);
    if (!parsed.ok) {
      return parsed.error;
    }
    const { options, files } = parsed;
    const opCount = [
      options.create,
      options.append,
      options.update,
      options.extract,
      options.list
    ].filter(Boolean).length;
    if (opCount === 0) {
      return {
        stdout: "",
        stderr: "tar: You must specify one of -c, -r, -u, -x, or -t\n",
        exitCode: 2
      };
    }
    if (opCount > 1) {
      return {
        stdout: "",
        stderr: "tar: You may not specify more than one of -c, -r, -u, -x, or -t\n",
        exitCode: 2
      };
    }
    if (options.autoCompress && options.file && options.create) {
      const file = options.file.toLowerCase();
      if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) {
        options.gzip = true;
      } else if (file.endsWith(".tar.bz2") || file.endsWith(".tbz2")) {
        options.bzip2 = true;
      } else if (file.endsWith(".tar.xz") || file.endsWith(".txz")) {
        options.xz = true;
      } else if (file.endsWith(".tar.zst") || file.endsWith(".tzst")) {
        options.zstd = true;
      }
    }
    const compCount = [
      options.gzip,
      options.bzip2,
      options.xz,
      options.zstd
    ].filter(Boolean).length;
    if (compCount > 1) {
      return {
        stdout: "",
        stderr: "tar: You may not specify more than one compression option\n",
        exitCode: 2
      };
    }
    if ((options.append || options.update) && compCount > 0) {
      return {
        stdout: "",
        stderr: "tar: Cannot append/update compressed archives - decompress first\n",
        exitCode: 2
      };
    }
    let finalFiles = files;
    if (options.filesFrom) {
      const filesFromPath = ctx.fs.resolvePath(ctx.cwd, options.filesFrom);
      try {
        const content = await ctx.fs.readFile(filesFromPath);
        const additionalFiles = content.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
        finalFiles = [...files, ...additionalFiles];
      } catch {
        return {
          stdout: "",
          stderr: `tar: ${options.filesFrom}: Cannot open: No such file or directory
`,
          exitCode: 2
        };
      }
    }
    if (options.excludeFrom) {
      const excludeFromPath = ctx.fs.resolvePath(ctx.cwd, options.excludeFrom);
      try {
        const content = await ctx.fs.readFile(excludeFromPath);
        const additionalExcludes = content.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
        options.exclude.push(...additionalExcludes);
      } catch {
        return {
          stdout: "",
          stderr: `tar: ${options.excludeFrom}: Cannot open: No such file or directory
`,
          exitCode: 2
        };
      }
    }
    if (options.create) {
      return createTarArchive(ctx, options, finalFiles);
    } else if (options.append) {
      return appendTarArchive(ctx, options, finalFiles);
    } else if (options.update) {
      return updateTarArchive(ctx, options, finalFiles);
    } else if (options.extract) {
      return extractTarArchive(ctx, options, finalFiles);
    } else {
      return listTarArchive(ctx, options, finalFiles);
    }
  }
};
export {
  tarCommand
};
