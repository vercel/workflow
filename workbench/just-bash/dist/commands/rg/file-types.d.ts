/**
 * Built-in file type definitions for rg
 *
 * Maps type names to file extensions and glob patterns.
 * Based on ripgrep's default type definitions.
 */
export interface FileType {
    extensions: string[];
    globs: string[];
}
/**
 * Mutable file type registry for runtime type modifications
 * Supports --type-add and --type-clear flags
 */
export declare class FileTypeRegistry {
    private types;
    constructor();
    /**
     * Add a type definition
     * Format: "name:pattern" where pattern can be:
     * - "*.ext" - glob pattern
     * - "include:other" - include patterns from another type
     */
    addType(spec: string): void;
    /**
     * Clear all patterns from a type
     */
    clearType(name: string): void;
    /**
     * Get a type by name
     */
    getType(name: string): FileType | undefined;
    /**
     * Get all type names
     */
    getAllTypes(): Map<string, FileType>;
    /**
     * Check if a filename matches any of the specified types
     */
    matchesType(filename: string, typeNames: string[]): boolean;
    /**
     * Check if a filename matches any recognized type
     */
    private matchesAnyType;
}
/**
 * Format type list for --type-list output
 */
export declare function formatTypeList(): string;
