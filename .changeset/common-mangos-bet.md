---
"@workflow/web-shared": patch
"@workflow/core": patch
"@workflow/web": patch
---

Added subpatch exports for runtime modules to allow direct imports in core. Refactored web-shared to be a thin package that exported UI components and world-actions. Updated web package to consume the UI components and world-actions from web-shared.
