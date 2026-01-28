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
export { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
export { Bash } from "./Bash.js";
export { defineCommand } from "./custom-commands.js";
// InMemoryFs is workflow-safe (no Node.js dependencies)
export { InMemoryFs } from "./fs/in-memory-fs/index.js";
export { NetworkAccessDeniedError, RedirectNotAllowedError, TooManyRedirectsError, } from "./network/index.js";
// NOTE: The following are NOT exported from this workflow entry point
// because they have Node.js dependencies at module level:
// - OverlayFs (uses node:fs, node:path)
// - ReadWriteFs (uses node:fs, node:path)
// - Sandbox (uses OverlayFs internally)
// - MountableFs (may mount OverlayFs/ReadWriteFs)
