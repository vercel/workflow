# Windows Workflow Discovery Debug Guide

## Issue: 0 Workflows on Windows vs 4+ on Mac/Linux

This document helps diagnose why workflows are not being discovered on Windows during `next build`.

## What to Look For

When you run `next build` on Windows, check the `.workflow-manifest-debug.json` file for:

```json
{
  "timestamp": "2025-11-04T12:34:56.789Z",
  "workflowCount": 0,
  "discoveredWorkflowFiles": [],
  "manifestWorkflowFiles": [],
  "workflows": [],
  "manifestFile": "...",
  "outfile": "..."
}
```

If `workflowCount` is 0 but `discoveredWorkflowFiles` is also empty, the issue is in the **discovery phase**.
If `discoveredWorkflowFiles` has entries but `manifestWorkflowFiles` is empty, the issue is in the **manifest building phase**.

## Console Output to Expect

### On Mac (Working):
```
[DEBUG] Discovered workflow files (4):
[
  './workflows/6_batching.ts',
  './workflows/98_duplicate_case.ts',
  './workflows/99_e2e.ts',
  './workflows/streams.ts'
]
Created intermediate workflow bundle 16ms
[DEBUG] Manifest has 4 workflow entries from 4 files
[DEBUG] Workflow files in manifest:
[ 'workflows/6_batching.ts', 'workflows/98_duplicate_case.ts', ... ]
DEBUG: Writing workflow manifest with 4 workflows
```

### On Windows (Broken):
```
[DEBUG] Discovered workflow files (0): []
Created intermediate workflow bundle Xms
[DEBUG] Manifest has 0 workflow entries from 0 files
[DEBUG] Workflow files in manifest: []
DEBUG: Writing workflow manifest with 0 workflows
```

## Likely Root Causes

### 1. Path Separator Issues (`\` vs `/`)
Windows uses backslashes (`\`) while the code may expect forward slashes (`/`).

**Key Files to Check:**
- `packages/cli/src/lib/builders/discover-entries-esbuild-plugin.ts` - Line 78: `state.discoveredWorkflows.push(args.path)`
- `packages/cli/src/lib/builders/swc-esbuild-plugin.ts` - Line 151-158: Where manifests are merged

**Fix Strategy:**
Normalize all paths to forward slashes before comparison/storage.

### 2. Pattern Matching Issues
The regex patterns for matching workflow files might not be working correctly on Windows.

**Patterns to Check:**
- Line 12 in `discover-entries-esbuild-plugin.ts`: `useWorkflowPattern = /^\s*(['"])use workflow\1;?\s*$/m`
- This should work regardless of OS, but file encoding might differ on Windows.

### 3. glob Pattern Issues
The `getInputFiles()` method uses glob patterns that might not work correctly on Windows.

**Check:**
- `packages/cli/src/lib/builders/base-builder.ts` lines 75-96: `getInputFiles()`

### 4. Working Directory Mismatch
The working directory might be set incorrectly on Windows.

**Check:**
- The debug file will show all paths - compare them with your actual file structure
- Look for mixed path separators (some `\`, some `/`)

## How to Run the Debug

1. **Run the build and capture output:**
   ```bash
   npm run build 2>&1 > build-output.txt
   ```

2. **Check the debug file:**
   ```bash
   # Adjust path as needed for your project
   cat "app\.well-known\workflow\v1\flow\.workflow-manifest-debug.json"
   ```

3. **Share the debug file contents** showing:
   - `discoveredWorkflowFiles` - Are any files listed?
   - `manifestWorkflowFiles` - After bundling, which files have workflows?
   - Console output - What's the discovery count vs manifest count?

## Testing Steps

1. Clean the output directory:
   ```bash
   rm -rf app/.well-known
   ```

2. Run build with increased logging:
   ```bash
   npm run build 2>&1 | grep -i "debug\|manifest\|workflow"
   ```

3. Check generated debug files:
   ```bash
   find . -name ".workflow-manifest-debug.json" -type f -exec cat {} \;
   ```

## Path Normalization Fix (if needed)

If the issue is path separators, look for fixes in:
- `discover-entries-esbuild-plugin.ts` - Store paths with normalized separators
- `swc-esbuild-plugin.ts` - Use normalized paths when building manifest
- `base-builder.ts` - Normalize paths in the virtual entry imports

Example fix:
```typescript
// Normalize path separators (convert \ to /)
const normalizedPath = args.path.replace(/\\/g, '/');
state.discoveredWorkflows.push(normalizedPath);
```

## Next Steps

1. Run `next build` on Windows
2. Check the `.workflow-manifest-debug.json` file
3. Compare `discoveredWorkflowFiles` vs `manifestWorkflowFiles`
4. Share the debug output to identify the exact failure point
