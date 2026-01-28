/**
 * just-bash CLI - A secure alternative to bash for AI agents
 *
 * Executes bash scripts in an isolated environment using OverlayFS.
 * Reads from the real filesystem, but writes stay in memory.
 *
 * Usage:
 *   just-bash [options] [root-path]
 *   just-bash -c 'script' [root-path]
 *   echo 'script' | just-bash [root-path]
 *   just-bash script.sh [root-path]
 *
 * Options:
 *   -c <script>       Execute the script from command line argument
 *   -e, --errexit     Exit immediately if a command exits with non-zero status
 *   --root <path>     Root directory for OverlayFS (default: current directory)
 *   --cwd <path>      Working directory within the sandbox (default: /)
 *   --json            Output results as JSON
 *   -h, --help        Show this help message
 *   -v, --version     Show version
 *
 * Arguments:
 *   script.sh         Script file to execute (reads from OverlayFS)
 *   root-path         Root directory (alternative to --root)
 *
 * Examples:
 *   # Execute inline script in current directory
 *   just-bash -c 'ls -la'
 *
 *   # Execute script from stdin with specific root
 *   echo 'cat README.md' | just-bash --root /path/to/project
 *
 *   # Execute script file
 *   just-bash ./deploy.sh
 *
 *   # Execute with errexit mode
 *   just-bash -e -c 'set -e; false; echo "not reached"'
 */
export {};
