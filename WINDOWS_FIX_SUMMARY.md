# Windows Workflow Discovery Fix - Summary

## Problem

When running `next build` on Windows, the workflow manifest was showing **0 workflows** while the same code on macOS showed **4 workflows**.

## Root Cause

The issue was in how file paths are being used in JavaScript `import` statements within the dynamically generated virtual entry file:

### On macOS (Working):
```javascript
import * as workflowFile0 from '/path/to/workflows/example.ts';
```

### On Windows (Broken):
```javascript
import * as workflowFile0 from 'C:\path\to\workflows\example.ts';
```

The backslash characters (`\`) in Windows paths break JavaScript import statements because:
1. They are treated as escape characters in JavaScript strings
2. esbuild cannot resolve the path correctly when it contains unescaped backslashes

## Solution

Normalize all file paths to use **forward slashes** (`/`) before using them in import statements. This works cross-platform since modern Node.js and JavaScript modules support forward slashes on Windows.

### Changes Made

**File 1: `packages/cli/src/lib/builders/base-builder.ts`**
- Line 268: Normalize step file paths in the imports
- Line 382-385: Normalize workflow file paths in the imports

**File 2: `packages/builders/src/base-builder.ts`**  
- Line 256: Normalize step file paths in the imports
- Line 371-376: Normalize workflow file paths in the imports

### Code Pattern

```typescript
// Before (Broken on Windows):
const imports = workflowFiles.map((file) => `import '${file}';`).join('\n');

// After (Works on all platforms):
const imports = workflowFiles.map((file) => {
  // Normalize path separators to forward slashes for cross-platform compatibility
  // This is critical for Windows where paths contain backslashes
  const normalizedPath = file.replace(/\\/g, '/');
  return `import '${normalizedPath}';`;
}).join('\n');
```

## Testing

### On macOS:
✅ Confirmed 4 workflows are discovered and manifest is generated correctly

### On Windows:
Please test with `npm run build` and verify:
1. **Console output** shows: `DEBUG: Writing workflow manifest with 4 workflows`
2. **Debug file** at `.well-known/workflow/v1/flow/.workflow-manifest-debug.json` shows:
   - `workflowCount: 4` (or appropriate count for your project)
   - `discoveredWorkflowFiles` contains paths with forward slashes
   - `manifestWorkflowFiles` is not empty

### Expected Debug Output

Before the build, clean the output:
```bash
rm -rf app/.well-known
npm run build 2>&1 | grep "DEBUG"
```

Expected console output:
```
[DEBUG] Discovered workflow files (4):
[ './workflows/6_batching.ts', './workflows/98_duplicate_case.ts', ... ]
[DEBUG] Manifest has 4 workflow entries from 4 files
[DEBUG] Workflow files in manifest:
[ 'workflows/6_batching.ts', 'workflows/98_duplicate_case.ts', ... ]
DEBUG: Writing workflow manifest with 4 workflows
```

Expected debug file (`.workflow-manifest-debug.json`):
```json
{
  "timestamp": "2025-11-04T01:01:01.947Z",
  "workflowCount": 4,
  "discoveredWorkflowFiles": [
    "C:\\path\\to\\workflows\\example.ts",
    ...
  ],
  "manifestWorkflowFiles": [
    "workflows/example.ts",
    ...
  ],
  "workflows": [
    "workflows/example.ts",
    ...
  ]
}
```

## Why This Works

1. **Path Normalization**: The `replace(/\\/g, '/')` converts all backslashes to forward slashes
2. **Cross-Platform Compatibility**: Node.js and modern module systems support forward slashes on Windows
3. **esbuild Support**: esbuild correctly resolves paths with forward slashes regardless of OS
4. **No Breaking Changes**: This only affects the generated virtual import code, not the file system operations

## Additional Improvements

While fixing the Windows issue, we also added enhanced debugging:

1. **Console Logging**: Shows discovered workflows and manifest building progress
2. **Debug JSON File**: Detailed information written to `.workflow-manifest-debug.json` including:
   - Timestamp of build
   - Count of workflows
   - Discovered workflow files
   - Manifest workflow files (after processing)
   - Paths to debug files for further inspection

This makes it much easier to diagnose cross-platform issues in the future.

## Files Modified

- `packages/cli/src/lib/builders/base-builder.ts`
- `packages/builders/src/base-builder.ts`

## Verification

Run on both Windows and macOS:
```bash
cd workbench/nextjs-turbopack
npm run build
cat "app\.well-known\workflow\v1\flow\.workflow-manifest-debug.json"
```

The output should be identical in terms of workflow counts and file names (just with different path separators in the intermediate steps).
