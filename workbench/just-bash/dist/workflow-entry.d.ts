/**
 * Workflow-optimized entry point for just-bash.
 *
 * This entry point exports a lightweight version of the Bash class that is
 * optimized for workflow context. It does NOT include command execution
 * capabilities, which dramatically reduces bundle size.
 *
 * Use this entry point via the "workflow" export condition:
 * - Automatically used by the Workflow DevKit builder
 * - Manually accessible via `import { Bash } from "just-bash"` when the
 *   "workflow" condition is active
 *
 * For step context (where you need to execute commands), use the full
 * Bash class which is available via the default export condition.
 */
export { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
export { Bash } from "./Bash.workflow.js";
export type { BashWorkflowOptions } from "./Bash.workflow.js";
export { InMemoryFs } from "./fs/in-memory-fs/index.js";
export type { BufferEncoding, CpOptions, DirectoryEntry, FileContent, FileEntry, FileInit, FileSystemFactory, FsEntry, FsStat, IFileSystem, InitialFiles, MkdirOptions, RmOptions, SymlinkEntry, } from "./fs/interface.js";
export type { ExecutionLimits } from "./limits.js";
