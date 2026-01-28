/**
 * Shared utilities for filesystem implementations
 */
import type { BufferEncoding, ReadFileOptions, WriteFileOptions } from "./interface.js";
export type FileContent = string | Uint8Array;
/**
 * Helper to convert content to Uint8Array
 */
export declare function toBuffer(content: FileContent, encoding?: BufferEncoding): Uint8Array;
/**
 * Helper to convert Uint8Array to string with encoding
 */
export declare function fromBuffer(buffer: Uint8Array, encoding?: BufferEncoding | null): string;
/**
 * Helper to get encoding from options
 */
export declare function getEncoding(options?: ReadFileOptions | WriteFileOptions | BufferEncoding | string | null): BufferEncoding | undefined;
