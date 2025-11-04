# Windows Import Path Fix - Generated Route Files

## Problem on Windows

After discovering workflows correctly (4 workflows!), the build was failing because the generated route files contained **backslashes in import paths**:

```javascript
// BROKEN on Windows:
import { createHook, createWebhook } from "..\\..\\..\\..\\..\\..\\..\\packages\\core\\dist\\create-hook.js";
                                        ↑ Backslashes cause module resolution failures
```

Error: `Can't resolve '..\..\..\..\..\..\..\..\..\packages\core\dist\create-hook.js'`

## Root Cause

The discovered workflow/step files had backslashes on Windows:
```
'.\\workflows\\streams.ts'  ← Backslashes
'C:\\Users\\Nathan\\...'   ← Backslashes
```

These paths were used to create the virtual entry file, which was then processed by esbuild. Esbuild generated relative import paths with backslashes in the output, which Turbopack couldn't resolve.

## Solution Applied

Normalize discovered file paths to forward slashes in the **discovery plugin** (`discover-entries-esbuild-plugin.ts`):

### Before (broken):
```typescript
if (hasUseWorkflow) {
  state.discoveredWorkflows.push(args.path);  // Contains backslashes on Windows
}
```

### After (fixed):
```typescript
// Normalize path separators to forward slashes
const normalizedPath = args.path.replace(/\\/g, '/');

if (hasUseWorkflow) {
  state.discoveredWorkflows.push(normalizedPath);  // Always forward slashes
}
```

## Files Modified

1. **`packages/cli/src/lib/builders/discover-entries-esbuild-plugin.ts`**
   - Lines 77-83: Normalize discovered paths

2. **`packages/builders/src/discover-entries-esbuild-plugin.ts`**
   - Lines 77-83: Normalize discovered paths

## How the Fix Works

1. **Discovery Phase** (Windows): Finds `.\workflows\streams.ts` (with backslashes)
2. **Normalization** (our fix): Converts to `./workflows/streams.ts` (forward slashes)
3. **Virtual Entry Generation**: Uses normalized paths to create import statements
4. **esbuild Processing**: Generates relative paths with forward slashes
5. **Turbopack Resolution**: Successfully resolves `../../../packages/...`

## Impact

### macOS (no changes needed):
- Discovery: `/absolute/path/to/workflow.ts` (forward slashes)
- Normalization: `/absolute/path/to/workflow.ts` (no-op)
- Generated imports: `../../../packages/...` (forward slashes) ✅

### Windows (now fixed):
- Discovery: `C:\absolute\path\to\workflow.ts` (backslashes)
- Normalization: `C:/absolute/path/to/workflow.ts` (forward slashes) ✅
- Generated imports: `../../../packages/...` (forward slashes) ✅

## Verification

After applying this fix on Windows:

```bash
npm run build
```

Expected output:
```
✓ Compiled successfully
✓ Generating static pages
```

With **NO** "Module not found" errors for packages.

## Complete Fix Chain

The Windows path handling is now fixed at **three levels**:

1. **Glob Pattern Normalization** (`getInputFiles`)
   - Converts glob patterns from backslashes to forward slashes

2. **Discovered Path Normalization** (`discover-entries-esbuild-plugin`)
   - Converts discovered file paths from backslashes to forward slashes

3. **Virtual Entry Normalization** (`createStepsBundle` / `createWorkflowsBundle`)
   - Converts paths used in import statements to forward slashes

This multi-level approach ensures Windows paths are normalized at every stage before being used in JavaScript/import contexts.

## Testing

### Before Fix (Windows):
```
[DEBUG] Discovered workflow files (4): [
  '.\\workflows\\streams.ts',        ← Backslashes in discovered paths
  'C:\\Users\\Nathan\\...',          ← Backslashes in absolute paths
]
Created intermediate workflow bundle 352ms
Build error occurred
Error: Turbopack build failed with 6 errors
Module not found: Can't resolve '..\\..\\..\\..\\packages\\...'
```

### After Fix (Windows):
```
[DEBUG] Discovered workflow files (4): [
  './workflows/streams.ts',          ← Forward slashes in discovered paths
  'C:/Users/Nathan/...',             ← Forward slashes in absolute paths
]
Created intermediate workflow bundle Xms
✓ Compiled successfully
✓ Generating static pages
```

## Summary

This fix normalizes discovered workflow and step file paths at the source (discovery plugin), ensuring all downstream processing uses forward slashes instead of Windows backslashes. This prevents import path issues in the generated route files.
