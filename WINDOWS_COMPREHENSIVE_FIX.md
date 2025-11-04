# Windows Workflow Discovery - Comprehensive Analysis & Fixes

## The Problem

On Windows: **0 workflows discovered**
On macOS: **4 workflows discovered**

## Root Cause Analysis

The issue is that **glob patterns with backslashes** are not being processed correctly by the glob library on Windows.

### Why This Happens:
1. Node.js `path.resolve()` returns paths with backslashes on Windows
2. These backslash paths are used directly in glob patterns
3. The glob library (tinyglobby) may not handle Windows paths correctly
4. Result: 0 files matched by glob = 0 workflows discovered

## Solution Applied

### Level 1: Glob Pattern Normalization (CRITICAL)
In `getInputFiles()`, normalize resolved paths to forward slashes:

```typescript
const resolvedDir = resolve(this.config.workingDir, dir);
// Convert C:\path\to\dir to C:/path/to/dir
const normalizedDir = resolvedDir.replace(/\\/g, '/');
const globPattern = `${normalizedDir}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`;
```

**Status**: ✅ Implemented in both `packages/cli/` and `packages/builders/`

### Level 2: Import Path Normalization (Already Done)
In `createStepsBundle()` and `createWorkflowsBundle()`, normalize file paths used in import statements:

```typescript
const normalizedPath = file.replace(/\\/g, '/');
const importStatement = `import '${normalizedPath}';`;
```

**Status**: ✅ Already implemented

## Changes Made

### File 1: `packages/cli/src/lib/builders/base-builder.ts`

**Line 75-110: `getInputFiles()` method**
- Added config dirs logging
- Added working dir logging
- Normalize resolved paths to forward slashes
- Log resolved directories
- Log glob patterns
- Log match count

### File 2: `packages/builders/src/base-builder.ts`

**Line 75-110: `getInputFiles()` method** (same changes)

## Testing Instructions for Windows

### Step 1: Clean Previous Build
```powershell
cd workbench\nextjs-turbopack
Remove-Item -Recurse -Force app\.well-known
```

### Step 2: Run Build with Debug Output
```powershell
npm run build 2>&1 | Tee-Object debug-output.txt
```

### Step 3: Check Debug Output
Look for these lines in the output:
```
[DEBUG] Config dirs: [ 'pages', 'app', 'src/pages', 'src/app' ]
[DEBUG] Working dir: C:\absolute\path\to\nextjs-turbopack
[DEBUG] Dir "pages" resolved to: C:/absolute/path/to/nextjs-turbopack/pages
[DEBUG] Glob patterns: [ "C:/absolute/path/to/nextjs-turbopack/pages/**/*.{...}", ... ]
[DEBUG] Glob matched 47 files
[DEBUG] First few matches: [ "C:/absolute/path/to/nextjs-turbopack/app/page.tsx", ... ]
[DEBUG] Discovered workflow files (4): [ './workflows/...', ... ]
```

### Step 4: Verify Success
**SUCCESS**: If you see `DEBUG: Writing workflow manifest with 4 workflows`

**FAILURE**: If you see `DEBUG: Writing workflow manifest with 0 workflows`

## What Each Debug Line Tells You

| Debug Line | What It Means | Windows Issue? |
|-----------|--------------|----------------|
| `Config dirs` | Which directories are being searched | If empty, no search happening |
| `Working dir` | Base directory for glob | If wrong, won't find files |
| `Dir resolved to` | Actual path being used | Should use `/` not `\` after fix |
| `Glob patterns` | The regex patterns sent to glob library | Should have `/` not `\` |
| `Glob matched X files` | How many files glob found | **0 means glob failed** |
| `Discovered workflow files` | How many have "use workflow" directive | 0 = workflows not found |

## Troubleshooting Checklist

### Checklist for "Glob matched 0 files":
- [ ] Is `Config dirs` showing directories? If empty, that's the problem
- [ ] Are the `Dir resolved to` paths correct and use `/` separators?
- [ ] Do those resolved paths actually exist on your system?
- [ ] Are you running from the correct directory?

### Checklist for "Glob matched 47 files but Discovered 0 workflows":
- [ ] Do your workflow files have `"use workflow"` directive at the top?
- [ ] Are they in the correct directories being searched?
- [ ] Check the first few glob matches - are they the right files?

### Checklist for " still 0 workflows after fix":
- [ ] Did you rebuild after the changes?
- [ ] Are you looking at the right debug output?
- [ ] Is your IDE/terminal capturing all output?

## Expected Results

### On macOS (Reference):
```
Discovering workflow directives 95ms
Created steps bundle 25ms
Created intermediate workflow bundle 14ms
DEBUG: Writing workflow manifest with 4 workflows
```

### On Windows (After Fix - Expected):
```
Discovering workflow directives 35ms
Created steps bundle 143ms
DEBUG: Writing workflow manifest with 4 workflows
Created intermediate workflow bundle 11ms
```

**Key Point**: The order and timing might differ, but the important number is the same: **4 workflows**

## Files Modified

1. `packages/cli/src/lib/builders/base-builder.ts`
   - `getInputFiles()` method (lines 75-110)
   - `createStepsBundle()` method (lines 266-271)
   - `createWorkflowsBundle()` method (lines 382-388)

2. `packages/builders/src/base-builder.ts`
   - Same changes as above

## How to Verify the Fix Works

```bash
# After building on Windows
cat "app\.well-known\workflow\v1\flow\.workflow-manifest-debug.json"

# Should show:
# {
#   "workflowCount": 4,
#   "discoveredWorkflowFiles": [...with paths using \ or /...],
#   "manifestWorkflowFiles": [...with paths using / only...],
#   "workflows": [...]
# }
```

## Summary

The fix addresses the **glob pattern path separator issue** on Windows by normalizing all paths to use forward slashes before passing them to the glob library. This is the **first critical fix** and should resolve the "0 workflows" issue.

If you still see 0 workflows after applying this fix:
1. Share the complete `[DEBUG]` output
2. Share your project structure
3. We'll investigate further with that information

The glob pattern normalization is **the most likely culprit** and this fix should resolve it.
