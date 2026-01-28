/**
 * CLI tool for executing bash scripts using Bash.
 *
 * Reads a bash script from stdin, parses it to an AST, executes it,
 * and outputs the AST, exit code, stderr, and stdout.
 *
 * Usage:
 *   echo '<script>' | pnpm dev:exec
 *   cat script.sh | pnpm dev:exec
 *
 * Options:
 *   --print-ast   Show the parsed AST
 *   --real-bash   Also run the script with real bash for comparison
 *   --root <path> Use OverlayFS with specified root directory
 *   --no-limit    Remove execution limits (for large scripts)
 *
 * Output:
 *   - AST: The parsed Abstract Syntax Tree as JSON (unless --no-ast)
 *   - exitCode: The exit code of the script
 *   - stderr: Standard error output (JSON string)
 *   - stdout: Standard output (JSON string)
 *   - (with --real-bash) Real bash output for comparison
 */
export {};
