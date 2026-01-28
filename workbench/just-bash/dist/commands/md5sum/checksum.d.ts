/**
 * Shared checksum utilities for md5sum, sha1sum, sha256sum
 * Uses WebCrypto API for SHA algorithms, pure JS for MD5
 */
import type { Command } from "../../types.js";
export type HashAlgorithm = "md5" | "sha1" | "sha256";
export declare function createChecksumCommand(name: string, algorithm: HashAlgorithm, summary: string): Command;
