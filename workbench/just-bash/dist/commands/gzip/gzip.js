/**
 * gzip - compress or expand files
 *
 * Also provides gunzip (decompress) and zcat (decompress to stdout) commands.
 */
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";
const gzipHelp = {
    name: "gzip",
    summary: "compress or expand files",
    usage: "gzip [OPTION]... [FILE]...",
    description: `Compress FILEs (by default, in-place).

When no FILE is given, or when FILE is -, read from standard input.

With -d, decompress instead.`,
    options: [
        "-c, --stdout      write to standard output, keep original files",
        "-d, --decompress  decompress",
        "-f, --force       force overwrite of output file",
        "-k, --keep        keep (don't delete) input files",
        "-l, --list        list compressed file contents",
        "-n, --no-name     do not save or restore the original name and timestamp",
        "-N, --name        save or restore the original file name and timestamp",
        "-q, --quiet       suppress all warnings",
        "-r, --recursive   operate recursively on directories",
        "-S, --suffix=SUF  use suffix SUF on compressed files (default: .gz)",
        "-t, --test        test compressed file integrity",
        "-v, --verbose     verbose mode",
        "-1, --fast        compress faster",
        "-9, --best        compress better",
        "    --help        display this help and exit",
    ],
};
const gunzipHelp = {
    name: "gunzip",
    summary: "decompress files",
    usage: "gunzip [OPTION]... [FILE]...",
    description: `Decompress FILEs (by default, in-place).

When no FILE is given, or when FILE is -, read from standard input.`,
    options: [
        "-c, --stdout      write to standard output, keep original files",
        "-f, --force       force overwrite of output file",
        "-k, --keep        keep (don't delete) input files",
        "-l, --list        list compressed file contents",
        "-n, --no-name     do not restore the original name and timestamp",
        "-N, --name        restore the original file name and timestamp",
        "-q, --quiet       suppress all warnings",
        "-r, --recursive   operate recursively on directories",
        "-S, --suffix=SUF  use suffix SUF on compressed files (default: .gz)",
        "-t, --test        test compressed file integrity",
        "-v, --verbose     verbose mode",
        "    --help        display this help and exit",
    ],
};
const zcatHelp = {
    name: "zcat",
    summary: "decompress files to stdout",
    usage: "zcat [OPTION]... [FILE]...",
    description: `Decompress FILEs to standard output.

When no FILE is given, or when FILE is -, read from standard input.`,
    options: [
        "-f, --force       force; read compressed data even from a terminal",
        "-l, --list        list compressed file contents",
        "-q, --quiet       suppress all warnings",
        "-S, --suffix=SUF  use suffix SUF on compressed files (default: .gz)",
        "-t, --test        test compressed file integrity",
        "-v, --verbose     verbose mode",
        "    --help        display this help and exit",
    ],
};
const argDefs = {
    stdout: { short: "c", long: "stdout", type: "boolean" },
    toStdout: { long: "to-stdout", type: "boolean" }, // alias
    decompress: { short: "d", long: "decompress", type: "boolean" },
    uncompress: { long: "uncompress", type: "boolean" }, // alias
    force: { short: "f", long: "force", type: "boolean" },
    keep: { short: "k", long: "keep", type: "boolean" },
    list: { short: "l", long: "list", type: "boolean" },
    noName: { short: "n", long: "no-name", type: "boolean" },
    name: { short: "N", long: "name", type: "boolean" },
    quiet: { short: "q", long: "quiet", type: "boolean" },
    recursive: { short: "r", long: "recursive", type: "boolean" },
    suffix: {
        short: "S",
        long: "suffix",
        type: "string",
        default: ".gz",
    },
    test: { short: "t", long: "test", type: "boolean" },
    verbose: { short: "v", long: "verbose", type: "boolean" },
    // Compression levels
    fast: { short: "1", long: "fast", type: "boolean" },
    level2: { short: "2", type: "boolean" },
    level3: { short: "3", type: "boolean" },
    level4: { short: "4", type: "boolean" },
    level5: { short: "5", type: "boolean" },
    level6: { short: "6", type: "boolean" },
    level7: { short: "7", type: "boolean" },
    level8: { short: "8", type: "boolean" },
    best: { short: "9", long: "best", type: "boolean" },
};
/**
 * Get compression level from flags (default is 6)
 */
function getCompressionLevel(flags) {
    if (flags.best)
        return constants.Z_BEST_COMPRESSION; // 9
    if (flags.level8)
        return 8;
    if (flags.level7)
        return 7;
    if (flags.level6)
        return 6;
    if (flags.level5)
        return 5;
    if (flags.level4)
        return 4;
    if (flags.level3)
        return 3;
    if (flags.level2)
        return 2;
    if (flags.fast)
        return constants.Z_BEST_SPEED; // 1
    return constants.Z_DEFAULT_COMPRESSION; // -1 (usually 6)
}
/**
 * Parse gzip header to extract original filename and metadata
 */
function parseGzipHeader(data) {
    // Gzip format: https://www.ietf.org/rfc/rfc1952.txt
    // Header is at least 10 bytes
    if (data.length < 10) {
        return { originalName: null, mtime: null, headerSize: 0 };
    }
    // Check magic number
    if (data[0] !== 0x1f || data[1] !== 0x8b) {
        return { originalName: null, mtime: null, headerSize: 0 };
    }
    const flags = data[3];
    const mtime = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
    let offset = 10;
    // FEXTRA
    if (flags & 0x04) {
        if (offset + 2 > data.length)
            return { originalName: null, mtime: null, headerSize: 0 };
        const xlen = data[offset] | (data[offset + 1] << 8);
        offset += 2 + xlen;
    }
    // FNAME - original filename
    let originalName = null;
    if (flags & 0x08) {
        const nameStart = offset;
        while (offset < data.length && data[offset] !== 0) {
            offset++;
        }
        if (offset < data.length) {
            originalName = new TextDecoder().decode(data.slice(nameStart, offset));
            offset++; // skip null terminator
        }
    }
    // FCOMMENT
    if (flags & 0x10) {
        while (offset < data.length && data[offset] !== 0) {
            offset++;
        }
        offset++; // skip null terminator
    }
    // FHCRC
    if (flags & 0x02) {
        offset += 2;
    }
    return {
        originalName,
        mtime: mtime > 0 ? new Date(mtime * 1000) : null,
        headerSize: offset,
    };
}
/**
 * Get the uncompressed size from gzip trailer (last 4 bytes)
 */
function getUncompressedSize(data) {
    if (data.length < 4)
        return 0;
    const len = data.length;
    return (data[len - 4] |
        (data[len - 3] << 8) |
        (data[len - 2] << 16) |
        (data[len - 1] << 24));
}
/**
 * Check if data is valid gzip
 */
function isGzip(data) {
    return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}
async function processFile(ctx, file, flags, cmdName, decompress, toStdout) {
    const suffix = flags.suffix;
    let inputPath;
    let outputPath;
    let inputData;
    // Handle stdin
    if (file === "-" || file === "") {
        inputData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
        if (decompress) {
            if (!isGzip(inputData)) {
                if (!flags.quiet) {
                    return {
                        stdout: "",
                        stderr: `${cmdName}: stdin: not in gzip format\n`,
                        exitCode: 1,
                    };
                }
                return { stdout: "", stderr: "", exitCode: 1 };
            }
            try {
                const decompressed = gunzipSync(inputData);
                // Use binary string (latin1) to preserve bytes
                return {
                    stdout: String.fromCharCode(...decompressed),
                    stderr: "",
                    exitCode: 0,
                };
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : "unknown error";
                return {
                    stdout: "",
                    stderr: `${cmdName}: stdin: ${msg}\n`,
                    exitCode: 1,
                };
            }
        }
        else {
            // Compress stdin
            const level = getCompressionLevel(flags);
            const compressed = gzipSync(inputData, { level });
            // Output raw bytes as binary - this is tricky since stdout is string
            // We'll use latin1 encoding to preserve bytes
            return {
                stdout: String.fromCharCode(...compressed),
                stderr: "",
                exitCode: 0,
            };
        }
    }
    // Resolve file path
    inputPath = ctx.fs.resolvePath(ctx.cwd, file);
    // Check if file exists
    try {
        const stat = await ctx.fs.stat(inputPath);
        if (stat.isDirectory) {
            if (flags.recursive) {
                // Process directory recursively
                return await processDirectory(ctx, inputPath, flags, cmdName, decompress, toStdout);
            }
            if (!flags.quiet) {
                return {
                    stdout: "",
                    stderr: `${cmdName}: ${file}: is a directory -- ignored\n`,
                    exitCode: 1,
                };
            }
            return { stdout: "", stderr: "", exitCode: 1 };
        }
    }
    catch {
        return {
            stdout: "",
            stderr: `${cmdName}: ${file}: No such file or directory\n`,
            exitCode: 1,
        };
    }
    // Read input file
    try {
        inputData = await ctx.fs.readFileBuffer(inputPath);
    }
    catch {
        return {
            stdout: "",
            stderr: `${cmdName}: ${file}: No such file or directory\n`,
            exitCode: 1,
        };
    }
    if (decompress) {
        // Decompression
        if (!file.endsWith(suffix)) {
            if (!flags.quiet) {
                return {
                    stdout: "",
                    stderr: `${cmdName}: ${file}: unknown suffix -- ignored\n`,
                    exitCode: 1,
                };
            }
            return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (!isGzip(inputData)) {
            if (!flags.quiet) {
                return {
                    stdout: "",
                    stderr: `${cmdName}: ${file}: not in gzip format\n`,
                    exitCode: 1,
                };
            }
            return { stdout: "", stderr: "", exitCode: 1 };
        }
        let decompressed;
        try {
            decompressed = gunzipSync(inputData);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : "unknown error";
            return {
                stdout: "",
                stderr: `${cmdName}: ${file}: ${msg}\n`,
                exitCode: 1,
            };
        }
        if (toStdout) {
            // Output to stdout using binary string (latin1) to preserve bytes
            return {
                stdout: String.fromCharCode(...decompressed),
                stderr: "",
                exitCode: 0,
            };
        }
        // Determine output filename
        if (flags.name) {
            const header = parseGzipHeader(inputData);
            if (header.originalName) {
                outputPath = ctx.fs.resolvePath(ctx.cwd, header.originalName);
            }
            else {
                outputPath = inputPath.slice(0, -suffix.length);
            }
        }
        else {
            outputPath = inputPath.slice(0, -suffix.length);
        }
        // Check if output exists
        if (!flags.force) {
            try {
                await ctx.fs.stat(outputPath);
                return {
                    stdout: "",
                    stderr: `${cmdName}: ${outputPath} already exists; not overwritten\n`,
                    exitCode: 1,
                };
            }
            catch {
                // File doesn't exist, good to proceed
            }
        }
        // Write decompressed file
        await ctx.fs.writeFile(outputPath, decompressed);
        // Remove original unless -k
        if (!flags.keep && !toStdout) {
            await ctx.fs.rm(inputPath);
        }
        if (flags.verbose) {
            const ratio = inputData.length > 0
                ? ((1 - inputData.length / decompressed.length) * 100).toFixed(1)
                : "0.0";
            return {
                stdout: "",
                stderr: `${file}:\t${ratio}% -- replaced with ${outputPath.split("/").pop()}\n`,
                exitCode: 0,
            };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
    }
    else {
        // Compression
        if (file.endsWith(suffix)) {
            if (!flags.quiet) {
                return {
                    stdout: "",
                    stderr: `${cmdName}: ${file} already has ${suffix} suffix -- unchanged\n`,
                    exitCode: 1,
                };
            }
            return { stdout: "", stderr: "", exitCode: 1 };
        }
        const level = getCompressionLevel(flags);
        let compressed;
        try {
            compressed = gzipSync(inputData, { level });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : "unknown error";
            return {
                stdout: "",
                stderr: `${cmdName}: ${file}: ${msg}\n`,
                exitCode: 1,
            };
        }
        if (toStdout) {
            // Output to stdout as binary
            return {
                stdout: String.fromCharCode(...compressed),
                stderr: "",
                exitCode: 0,
            };
        }
        outputPath = inputPath + suffix;
        // Check if output exists
        if (!flags.force) {
            try {
                await ctx.fs.stat(outputPath);
                return {
                    stdout: "",
                    stderr: `${cmdName}: ${outputPath} already exists; not overwritten\n`,
                    exitCode: 1,
                };
            }
            catch {
                // File doesn't exist, good to proceed
            }
        }
        // Write compressed file
        await ctx.fs.writeFile(outputPath, compressed);
        // Remove original unless -k
        if (!flags.keep && !toStdout) {
            await ctx.fs.rm(inputPath);
        }
        if (flags.verbose) {
            const ratio = inputData.length > 0
                ? ((1 - compressed.length / inputData.length) * 100).toFixed(1)
                : "0.0";
            return {
                stdout: "",
                stderr: `${file}:\t${ratio}% -- replaced with ${outputPath.split("/").pop()}\n`,
                exitCode: 0,
            };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
    }
}
async function processDirectory(ctx, dirPath, flags, cmdName, decompress, toStdout) {
    const entries = await ctx.fs.readdir(dirPath);
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (const entry of entries) {
        const entryPath = ctx.fs.resolvePath(dirPath, entry);
        const stat = await ctx.fs.stat(entryPath);
        if (stat.isDirectory) {
            const result = await processDirectory(ctx, entryPath, flags, cmdName, decompress, toStdout);
            stdout += result.stdout;
            stderr += result.stderr;
            if (result.exitCode !== 0)
                exitCode = result.exitCode;
        }
        else if (stat.isFile) {
            // For decompression, only process files with the suffix
            // For compression, skip files that already have the suffix
            const suffix = flags.suffix;
            if (decompress && !entry.endsWith(suffix))
                continue;
            if (!decompress && entry.endsWith(suffix))
                continue;
            const relativePath = entryPath.startsWith(`${ctx.cwd}/`)
                ? entryPath.slice(ctx.cwd.length + 1)
                : entryPath;
            const result = await processFile(ctx, relativePath, flags, cmdName, decompress, toStdout);
            stdout += result.stdout;
            stderr += result.stderr;
            if (result.exitCode !== 0)
                exitCode = result.exitCode;
        }
    }
    return { stdout, stderr, exitCode };
}
async function listFile(ctx, file, flags, cmdName) {
    let inputData;
    if (file === "-" || file === "") {
        inputData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
    }
    else {
        const inputPath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
            inputData = await ctx.fs.readFileBuffer(inputPath);
        }
        catch {
            return {
                stdout: "",
                stderr: `${cmdName}: ${file}: No such file or directory\n`,
                exitCode: 1,
            };
        }
    }
    if (!isGzip(inputData)) {
        if (!flags.quiet) {
            return {
                stdout: "",
                stderr: `${cmdName}: ${file}: not in gzip format\n`,
                exitCode: 1,
            };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
    }
    const compressed = inputData.length;
    const uncompressed = getUncompressedSize(inputData);
    const ratio = uncompressed > 0
        ? ((1 - compressed / uncompressed) * 100).toFixed(1)
        : "0.0";
    const header = parseGzipHeader(inputData);
    const name = header.originalName || (file === "-" ? "" : file.replace(/\.gz$/, ""));
    // Format: compressed uncompressed ratio uncompressed_name
    const line = `${compressed.toString().padStart(10)} ${uncompressed.toString().padStart(10)} ${ratio.padStart(5)}% ${name}\n`;
    return { stdout: line, stderr: "", exitCode: 0 };
}
async function testFile(ctx, file, flags, cmdName) {
    let inputData;
    if (file === "-" || file === "") {
        inputData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
    }
    else {
        const inputPath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
            inputData = await ctx.fs.readFileBuffer(inputPath);
        }
        catch {
            return {
                stdout: "",
                stderr: `${cmdName}: ${file}: No such file or directory\n`,
                exitCode: 1,
            };
        }
    }
    if (!isGzip(inputData)) {
        if (!flags.quiet) {
            return {
                stdout: "",
                stderr: `${cmdName}: ${file}: not in gzip format\n`,
                exitCode: 1,
            };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
    }
    try {
        gunzipSync(inputData);
        if (flags.verbose) {
            return { stdout: "", stderr: `${file}:\tOK\n`, exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "invalid";
        return {
            stdout: "",
            stderr: `${cmdName}: ${file}: ${msg}\n`,
            exitCode: 1,
        };
    }
}
async function executeGzip(args, ctx, cmdName) {
    // Determine help based on command name
    const help = cmdName === "zcat"
        ? zcatHelp
        : cmdName === "gunzip"
            ? gunzipHelp
            : gzipHelp;
    if (hasHelpFlag(args)) {
        return showHelp(help);
    }
    const parsed = parseArgs(cmdName, args, argDefs);
    if (!parsed.ok) {
        // Check if it's an unknown option error
        if (parsed.error.stderr.includes("unrecognized option")) {
            return parsed.error;
        }
        return parsed.error;
    }
    const flags = parsed.result.flags;
    let files = parsed.result.positional;
    // Determine mode based on command name and flags
    const decompress = cmdName === "gunzip" ||
        cmdName === "zcat" ||
        flags.decompress ||
        flags.uncompress;
    const toStdout = cmdName === "zcat" || flags.stdout || flags.toStdout;
    // Handle -l (list)
    if (flags.list) {
        if (files.length === 0)
            files = ["-"];
        let stdout = "  compressed uncompressed  ratio uncompressed_name\n";
        let stderr = "";
        let exitCode = 0;
        for (const file of files) {
            const result = await listFile(ctx, file, flags, cmdName);
            stdout += result.stdout;
            stderr += result.stderr;
            if (result.exitCode !== 0)
                exitCode = result.exitCode;
        }
        return { stdout, stderr, exitCode };
    }
    // Handle -t (test)
    if (flags.test) {
        if (files.length === 0)
            files = ["-"];
        let stdout = "";
        let stderr = "";
        let exitCode = 0;
        for (const file of files) {
            const result = await testFile(ctx, file, flags, cmdName);
            stdout += result.stdout;
            stderr += result.stderr;
            if (result.exitCode !== 0)
                exitCode = result.exitCode;
        }
        return { stdout, stderr, exitCode };
    }
    // No files specified - use stdin
    if (files.length === 0) {
        files = ["-"];
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (const file of files) {
        const result = await processFile(ctx, file, flags, cmdName, decompress, toStdout);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0)
            exitCode = result.exitCode;
    }
    return { stdout, stderr, exitCode };
}
export const gzipCommand = {
    name: "gzip",
    async execute(args, ctx) {
        return executeGzip(args, ctx, "gzip");
    },
};
export const gunzipCommand = {
    name: "gunzip",
    async execute(args, ctx) {
        return executeGzip(args, ctx, "gunzip");
    },
};
export const zcatCommand = {
    name: "zcat",
    async execute(args, ctx) {
        return executeGzip(args, ctx, "zcat");
    },
};
