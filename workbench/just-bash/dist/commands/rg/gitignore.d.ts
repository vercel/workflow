/**
 * .gitignore parser for rg
 *
 * Handles:
 * - Simple patterns (*.log, node_modules/)
 * - Negation patterns (!important.log)
 * - Directory-only patterns (build/)
 * - Rooted patterns (/root-only)
 * - Double-star patterns (for matching across directories)
 */
import type { IFileSystem } from "../../fs/interface.js";
export declare class GitignoreParser {
    private patterns;
    private basePath;
    constructor(basePath?: string);
    /**
     * Parse .gitignore content and add patterns
     */
    parse(content: string): void;
    /**
     * Convert a gitignore pattern to a regex
     */
    private patternToRegex;
    /**
     * Check if a path should be ignored
     *
     * @param relativePath Path relative to the gitignore location
     * @param isDirectory Whether the path is a directory
     * @returns true if the path should be ignored
     */
    matches(relativePath: string, isDirectory: boolean): boolean;
    /**
     * Check if a path is explicitly whitelisted by a negation pattern
     *
     * @param relativePath Path relative to the gitignore location
     * @param isDirectory Whether the path is a directory
     * @returns true if the path is whitelisted by a negation pattern
     */
    isWhitelisted(relativePath: string, isDirectory: boolean): boolean;
    /**
     * Get the base path for this gitignore
     */
    getBasePath(): string;
}
/**
 * Hierarchical gitignore manager
 *
 * Loads .gitignore and .ignore files from the root down to the current directory,
 * applying patterns in order (child patterns override parent patterns).
 */
export declare class GitignoreManager {
    private parsers;
    private fs;
    private skipDotIgnore;
    private skipVcsIgnore;
    private loadedDirs;
    constructor(fs: IFileSystem, _rootPath: string, skipDotIgnore?: boolean, skipVcsIgnore?: boolean);
    /**
     * Load all .gitignore and .ignore files from root to the specified path
     */
    load(targetPath: string): Promise<void>;
    /**
     * Load ignore files for a directory during traversal.
     * Only loads if the directory hasn't been loaded before.
     */
    loadForDirectory(dir: string): Promise<void>;
    /**
     * Add patterns from raw content at the specified base path.
     * Used for --ignore-file flag.
     */
    addPatternsFromContent(content: string, basePath: string): void;
    /**
     * Check if a path should be ignored
     *
     * @param absolutePath Absolute path to check
     * @param isDirectory Whether the path is a directory
     * @returns true if the path should be ignored
     */
    matches(absolutePath: string, isDirectory: boolean): boolean;
    /**
     * Check if a path is explicitly whitelisted by a negation pattern.
     * Used to include hidden files that have negation patterns like "!.foo"
     *
     * @param absolutePath Absolute path to check
     * @param isDirectory Whether the path is a directory
     * @returns true if the path is whitelisted by a negation pattern
     */
    isWhitelisted(absolutePath: string, isDirectory: boolean): boolean;
    /**
     * Quick check for common ignored directories
     * Used for early pruning during traversal
     */
    static isCommonIgnored(name: string): boolean;
}
/**
 * Load gitignore files for a search starting at the given path
 */
export declare function loadGitignores(fs: IFileSystem, startPath: string, skipDotIgnore?: boolean, skipVcsIgnore?: boolean, customIgnoreFiles?: string[]): Promise<GitignoreManager>;
