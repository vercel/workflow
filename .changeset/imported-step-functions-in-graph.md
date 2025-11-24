---
"@workflow/swc-plugin": patch
"@workflow/web": patch
---

Fixed workflow graph visualization to properly handle step functions defined in separate files:

1. **SWC Plugin**: The graph builder now tracks imported identifiers and treats them as potential steps when called as functions, allowing workflows to use step functions from separate modules without requiring them to be inlined in the same file.

2. **Web Dashboard**: Fixed the graph execution mapper to match runtime step executions to graph nodes by function name when exact stepId matching fails. This handles the case where graph nodes reference steps from the workflow file (where they're called) but runtime execution records the actual file where the step is defined. The mapper now shows correct execution status (completed/failed/retrying) for steps in separate files.

