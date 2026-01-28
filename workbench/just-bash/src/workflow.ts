/**
 * Workflow-compatible exports for just-bash.
 *
 * This entry point only exports classes and functions that are safe to use
 * in Workflow DevKit environments (no Node.js-specific imports at module level).
 *
 * Use this entry point when importing just-bash in workflow code:
 *   import { Bash, InMemoryFs } from "just-bash/workflow";
 */

// Re-export Workflow serde symbols for user convenience
export { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';

// Bash class and related types
export type { BashLogger, BashOptions, ExecOptions } from './Bash.js';
export { Bash } from './Bash.js';
// Command registry types only (no runtime code that would pull in command loaders)
export type {
  AllCommandName,
  CommandName,
  NetworkCommandName,
} from './commands/registry.js';
// NOTE: getCommandNames and getNetworkCommandNames are NOT exported from the
// workflow entry point because they reference commandLoaders which has dynamic
// imports to all command implementations. These functions are available from
// the main "just-bash" entry point for use in step context.
// Custom commands API
export type { CustomCommand, LazyCommand } from './custom-commands.js';
export { defineCommand } from './custom-commands.js';
// InMemoryFs is workflow-safe (no Node.js dependencies)
export { InMemoryFs } from './fs/in-memory-fs/index.js';
// Types that are safe to export (type-only, no runtime code)
export type {
  BufferEncoding,
  CpOptions,
  DirectoryEntry,
  FileContent,
  FileEntry,
  FileInit,
  FileSystemFactory,
  FsEntry,
  FsStat,
  IFileSystem,
  InitialFiles,
  MkdirOptions,
  RmOptions,
  SymlinkEntry,
} from './fs/interface.js';

// Network types (type-only exports)
export type { NetworkConfig } from './network/index.js';
export {
  NetworkAccessDeniedError,
  RedirectNotAllowedError,
  TooManyRedirectsError,
} from './network/index.js';

// Result types
export type {
  BashExecResult,
  Command,
  CommandContext,
  ExecResult,
} from './types.js';

// NOTE: The following are NOT exported from this workflow entry point
// because they have Node.js dependencies at module level:
// - OverlayFs (uses node:fs, node:path)
// - ReadWriteFs (uses node:fs, node:path)
// - Sandbox (uses OverlayFs internally)
// - MountableFs (may mount OverlayFs/ReadWriteFs)
