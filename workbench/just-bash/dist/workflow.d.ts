/**
 * Workflow-compatible exports for just-bash.
 *
 * This entry point only exports classes and functions that are safe to use
 * in Workflow DevKit environments (no Node.js-specific imports at module level).
 *
 * Use this entry point when importing just-bash in workflow code:
 *   import { Bash, InMemoryFs } from "just-bash/workflow";
 */
export { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
export type { BashLogger, BashOptions, ExecOptions } from "./Bash.js";
export { Bash } from "./Bash.js";
export type { AllCommandName, CommandName, NetworkCommandName, } from "./commands/registry.js";
export type { CustomCommand, LazyCommand } from "./custom-commands.js";
export { defineCommand } from "./custom-commands.js";
export { InMemoryFs } from "./fs/in-memory-fs/index.js";
export type { BufferEncoding, CpOptions, DirectoryEntry, FileContent, FileEntry, FileInit, FileSystemFactory, FsEntry, FsStat, IFileSystem, InitialFiles, MkdirOptions, RmOptions, SymlinkEntry, } from "./fs/interface.js";
export type { NetworkConfig } from "./network/index.js";
export { NetworkAccessDeniedError, RedirectNotAllowedError, TooManyRedirectsError, } from "./network/index.js";
export type { BashExecResult, Command, CommandContext, ExecResult, } from "./types.js";
