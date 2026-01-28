/**
 * Glob Expander - Expands glob patterns to matching file paths
 *
 * Handles:
 * - * (matches any characters except /)
 * - ** (matches any characters including /)
 * - ? (matches single character)
 * - [...] (character classes)
 */
import type { IFileSystem } from "../fs/interface.js";
export interface GlobOptions {
    globstar?: boolean;
    nullglob?: boolean;
    failglob?: boolean;
    dotglob?: boolean;
    extglob?: boolean;
    globskipdots?: boolean;
}
export declare class GlobExpander {
    private fs;
    private cwd;
    private globignorePatterns;
    private hasGlobignore;
    private globstar;
    private nullglob;
    private failglob;
    private dotglob;
    private extglob;
    private globskipdots;
    constructor(fs: IFileSystem, cwd: string, env?: Record<string, string>, options?: GlobOptions | boolean);
    /**
     * Check if nullglob is enabled (return empty for non-matching patterns)
     */
    hasNullglob(): boolean;
    /**
     * Check if failglob is enabled (throw error for non-matching patterns)
     */
    hasFailglob(): boolean;
    /**
     * Filter results based on GLOBIGNORE patterns and globskipdots option
     * When GLOBIGNORE is set, . and .. are always filtered
     * When globskipdots is enabled (default in bash >=5.2), . and .. are also filtered
     */
    private filterGlobignore;
    /**
     * Match a path against a GLOBIGNORE pattern
     * GLOBIGNORE patterns are matched against the complete result path.
     * Unlike regular glob matching, * does NOT match / in GLOBIGNORE patterns.
     * This means *.txt filters "foo.txt" but NOT "dir/foo.txt".
     */
    private matchGlobignorePattern;
    /**
     * Check if a string contains glob characters
     */
    isGlobPattern(str: string): boolean;
    /**
     * Expand an array of arguments, replacing glob patterns with matched files
     * @param args - Array of argument strings
     * @param quotedFlags - Optional array indicating which args were quoted (should not expand)
     */
    expandArgs(args: string[], quotedFlags?: boolean[]): Promise<string[]>;
    /**
     * Expand a single glob pattern
     */
    expand(pattern: string): Promise<string[]>;
    /**
     * Check if ** is used as a complete path segment (not adjacent to other chars).
     * ** only recurses when it appears as a standalone segment like:
     *   - ** at start
     *   - / ** / in middle (no spaces)
     *   - / ** at end (no spaces)
     * NOT when adjacent to other characters like d** or **y
     */
    private isGlobstarValid;
    /**
     * Check if a path segment contains glob characters
     */
    private hasGlobChars;
    /**
     * Expand a simple glob pattern (no **).
     * Handles multi-segment patterns like /dm/star/star.json
     */
    private expandSimple;
    /**
     * Recursively expand path segments with glob patterns
     * @param fsPath - The actual filesystem path to read from
     * @param resultPrefix - The prefix to use when building result paths
     * @param segments - Remaining glob segments to match
     */
    private expandSegments;
    /**
     * Expand a recursive glob pattern (contains **)
     */
    private expandRecursive;
    /**
     * Walk directory for patterns with multiple globstar (like dir/star-star/subdir/star-star/etc)
     * At each directory level, recursively expand the sub-pattern that contains globstar
     */
    private walkDirectoryMultiGlobstar;
    /**
     * Recursively walk a directory and collect matching files
     */
    private walkDirectory;
    /**
     * Match a filename against a glob pattern
     */
    matchPattern(name: string, pattern: string): boolean;
    /**
     * Convert a glob pattern to a RegExp
     */
    private patternToRegex;
    /**
     * Convert a glob pattern to a regex string (without anchors)
     */
    private patternToRegexStr;
    /**
     * Compute the fixed length of a pattern, if it has one.
     * Returns null if the pattern has variable length (contains *, +, etc.).
     * Used to optimize !() extglob patterns.
     */
    private computePatternLength;
}
