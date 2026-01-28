/**
 * Tar archive utilities using modern-tar
 *
 * Provides helpers for creating and extracting tar archives
 * with optional gzip, bzip2, and xz compression.
 */
import { type ParsedTarEntryWithData, type TarEntry, type TarHeader } from "modern-tar";
export type { TarEntry, TarHeader, ParsedTarEntryWithData };
/**
 * Entry for creating a tar archive
 */
export interface TarCreateEntry {
    name: string;
    content?: Uint8Array | string;
    mode?: number;
    mtime?: Date;
    isDirectory?: boolean;
    isSymlink?: boolean;
    linkTarget?: string;
    uid?: number;
    gid?: number;
}
/**
 * Create a tar archive from entries
 */
export declare function createArchive(entries: TarCreateEntry[]): Promise<Uint8Array>;
/**
 * Create a gzip-compressed tar archive from entries
 */
export declare function createCompressedArchive(entries: TarCreateEntry[]): Promise<Uint8Array>;
/**
 * Parsed tar entry for extraction
 */
export interface ParsedEntry {
    name: string;
    mode: number;
    uid: number;
    gid: number;
    size: number;
    mtime: Date;
    type: "file" | "directory" | "symlink" | "hardlink" | "other";
    linkTarget?: string;
    content: Uint8Array;
}
/**
 * Parse a tar archive and return entries
 */
export declare function parseArchive(data: Uint8Array): Promise<{
    entries: ParsedEntry[];
    error?: string;
}>;
/**
 * Parse a gzip-compressed tar archive
 */
export declare function parseCompressedArchive(data: Uint8Array): Promise<{
    entries: ParsedEntry[];
    error?: string;
}>;
/**
 * Check if data is gzip compressed (magic bytes 0x1f 0x8b)
 */
export declare function isGzipCompressed(data: Uint8Array): boolean;
/**
 * Check if data is bzip2 compressed (magic bytes "BZh")
 */
export declare function isBzip2Compressed(data: Uint8Array): boolean;
/**
 * Check if data is xz compressed (magic bytes 0xFD 0x37 0x7A 0x58 0x5A 0x00)
 */
export declare function isXzCompressed(data: Uint8Array): boolean;
/**
 * Create a bzip2-compressed tar archive from entries
 */
export declare function createBzip2CompressedArchive(entries: TarCreateEntry[]): Promise<Uint8Array>;
/**
 * Create an xz-compressed tar archive from entries
 */
export declare function createXzCompressedArchive(entries: TarCreateEntry[]): Promise<Uint8Array>;
/**
 * Parse a bzip2-compressed tar archive
 */
export declare function parseBzip2CompressedArchive(data: Uint8Array): Promise<{
    entries: ParsedEntry[];
    error?: string;
}>;
/**
 * Parse an xz-compressed tar archive
 */
export declare function parseXzCompressedArchive(data: Uint8Array): Promise<{
    entries: ParsedEntry[];
    error?: string;
}>;
/**
 * Check if data is zstd compressed (magic number 0x28 0xB5 0x2F 0xFD)
 */
export declare function isZstdCompressed(data: Uint8Array): boolean;
/**
 * Create a zstd-compressed tar archive from entries
 */
export declare function createZstdCompressedArchive(entries: TarCreateEntry[]): Promise<Uint8Array>;
/**
 * Parse a zstd-compressed tar archive
 */
export declare function parseZstdCompressedArchive(data: Uint8Array): Promise<{
    entries: ParsedEntry[];
    error?: string;
}>;
