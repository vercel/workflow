---
"@workflow/builders": patch
"@workflow/next": patch
"@workflow/web": patch
---

Refactor graph extraction to post-bundle TypeScript AST traversal. This replaces the previous Rust-based per-file analysis with a more accurate approach that analyzes the bundled workflow code, enabling:

- Full CFG representation including loops, conditionals, and parallel execution
- Detection of step functions from imported packages
- Detection of indirect step calls through helper functions
- Step reference detection in tool configurations

Web dashboard improvements:
- Migrate to nuqs for URL state management
- Add graph execution mapper to match runtime step executions to graph nodes
- Improve workflow graph visualization with proper execution status display

