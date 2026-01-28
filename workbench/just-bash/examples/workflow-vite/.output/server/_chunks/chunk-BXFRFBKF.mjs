import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
import { _ as __name } from "../index.mjs";
var WEBCRYPTO_ALGORITHMS = {
  sha1: "SHA-1",
  sha256: "SHA-256"
};
function md5(bytes) {
  function rotateLeft(x, n) {
    return x << n | x >>> 32 - n;
  }
  __name(rotateLeft, "rotateLeft");
  const K = new Uint32Array([
    3614090360,
    3905402710,
    606105819,
    3250441966,
    4118548399,
    1200080426,
    2821735955,
    4249261313,
    1770035416,
    2336552879,
    4294925233,
    2304563134,
    1804603682,
    4254626195,
    2792965006,
    1236535329,
    4129170786,
    3225465664,
    643717713,
    3921069994,
    3593408605,
    38016083,
    3634488961,
    3889429448,
    568446438,
    3275163606,
    4107603335,
    1163531501,
    2850285829,
    4243563512,
    1735328473,
    2368359562,
    4294588738,
    2272392833,
    1839030562,
    4259657740,
    2763975236,
    1272893353,
    4139469664,
    3200236656,
    681279174,
    3936430074,
    3572445317,
    76029189,
    3654602809,
    3873151461,
    530742520,
    3299628645,
    4096336452,
    1126891415,
    2878612391,
    4237533241,
    1700485571,
    2399980690,
    4293915773,
    2240044497,
    1873313359,
    4264355552,
    2734768916,
    1309151649,
    4149444226,
    3174756917,
    718787259,
    3951481745
  ]);
  const S = [
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21
  ];
  const bitLen = bytes.length * 8;
  const paddingLen = (bytes.length % 64 < 56 ? 56 : 120) - bytes.length % 64;
  const padded = new Uint8Array(bytes.length + paddingLen + 8);
  padded.set(bytes);
  padded[bytes.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);
  let a0 = 1732584193;
  let b0 = 4023233417;
  let c0 = 2562383102;
  let d0 = 271733878;
  for (let i = 0; i < padded.length; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(i + j * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let F, g;
      if (j < 16) {
        F = B & C | ~B & D;
        g = j;
      } else if (j < 32) {
        F = D & B | ~D & C;
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        F = B ^ C ^ D;
        g = (3 * j + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = 7 * j % 16;
      }
      F = F + A + K[j] + M[g] >>> 0;
      A = D;
      D = C;
      C = B;
      B = B + rotateLeft(F, S[j]) >>> 0;
    }
    a0 = a0 + A >>> 0;
    b0 = b0 + B >>> 0;
    c0 = c0 + C >>> 0;
    d0 = d0 + D >>> 0;
  }
  const result = new Uint8Array(16);
  new DataView(result.buffer).setUint32(0, a0, true);
  new DataView(result.buffer).setUint32(4, b0, true);
  new DataView(result.buffer).setUint32(8, c0, true);
  new DataView(result.buffer).setUint32(12, d0, true);
  return Array.from(result).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(md5, "md5");
async function computeHash(algorithm, data) {
  if (algorithm === "md5") {
    return md5(data);
  }
  const hashBuffer = await globalThis.crypto.subtle.digest(WEBCRYPTO_ALGORITHMS[algorithm], new Uint8Array(data).buffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(computeHash, "computeHash");
function createChecksumCommand(name, algorithm, summary) {
  const help = {
    name,
    summary,
    usage: `${name} [OPTION]... [FILE]...`,
    options: [
      "-c, --check    read checksums from FILEs and check them",
      "    --help     display this help and exit"
    ]
  };
  return {
    name,
    async execute(args, ctx) {
      if (hasHelpFlag(args))
        return showHelp(help);
      let check = false;
      const files = [];
      for (const arg of args) {
        if (arg === "-c" || arg === "--check")
          check = true;
        else if (arg === "-b" || arg === "-t" || arg === "--binary" || arg === "--text") ;
        else if (arg.startsWith("-") && arg !== "-")
          return unknownOption(name, arg);
        else
          files.push(arg);
      }
      if (files.length === 0)
        files.push("-");
      const readBinary = /* @__PURE__ */ __name(async (file) => {
        if (file === "-") {
          return Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
        }
        try {
          return await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, file));
        } catch {
          return null;
        }
      }, "readBinary");
      if (check) {
        let failed = 0;
        let output2 = "";
        for (const file of files) {
          const content = file === "-" ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file)).catch(() => null);
          if (content === null)
            return {
              stdout: "",
              stderr: `${name}: ${file}: No such file or directory
`,
              exitCode: 1
            };
          for (const line of content.split("\n")) {
            const match = line.match(/^([a-fA-F0-9]+)\s+[* ]?(.+)$/);
            if (!match)
              continue;
            const [, expectedHash, targetFile] = match;
            const fileContent = await readBinary(targetFile);
            if (fileContent === null) {
              output2 += `${targetFile}: FAILED open or read
`;
              failed++;
              continue;
            }
            const ok = await computeHash(algorithm, fileContent) === expectedHash.toLowerCase();
            output2 += `${targetFile}: ${ok ? "OK" : "FAILED"}
`;
            if (!ok)
              failed++;
          }
        }
        if (failed > 0)
          output2 += `${name}: WARNING: ${failed} computed checksum${failed > 1 ? "s" : ""} did NOT match
`;
        return { stdout: output2, stderr: "", exitCode: failed > 0 ? 1 : 0 };
      }
      let output = "";
      let exitCode = 0;
      for (const file of files) {
        const content = await readBinary(file);
        if (content === null) {
          output += `${name}: ${file}: No such file or directory
`;
          exitCode = 1;
          continue;
        }
        output += `${await computeHash(algorithm, content)}  ${file}
`;
      }
      return { stdout: output, stderr: "", exitCode };
    }
  };
}
__name(createChecksumCommand, "createChecksumCommand");
export {
  createChecksumCommand as c
};
