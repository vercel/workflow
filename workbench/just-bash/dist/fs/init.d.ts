/**
 * Filesystem Initialization
 *
 * Sets up the default filesystem structure for the bash environment
 * including /dev, /proc, and common directories.
 */
import type { IFileSystem } from "./interface.js";
/**
 * Initialize the filesystem with standard directories and files
 * Works with both InMemoryFs and OverlayFs (both write to memory)
 */
export declare function initFilesystem(fs: IFileSystem, useDefaultLayout: boolean): void;
