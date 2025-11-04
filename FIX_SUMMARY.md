# Windows Workflow Discovery Fix - Complete Summary

## Issue Identified

**On Windows**: `DEBUG: Writing workflow manifest with 0 workflows`
**On macOS**: `DEBUG: Writing workflow manifest with 4 workflows`

The root cause was that glob patterns were constructed with Windows backslashes, which the glob library couldn't handle properly.

## Changes Made

### Root Cause Fix: Glob Pattern Path Normalization

In `getInputFiles()` method (both `packages/cli/` and `packages/builders/`):

```diff
- const patterns = this.config.dirs.map((dir) =>
-   `${resolve(this.config.workingDir, dir)}/**/*.{...}`
- );

+ const patterns = this.config.dirs.map((dir) => {
+   const resolvedDir = resolve(this.config.workingDir, dir);
+   // Normalize path separators to forward slashes for glob compatibility
+   const normalizedDir = resolvedDir.replace(/\\/g, '/');
+   return `${normalizedDir}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`;
+ });
```

**Why this works:**
- On Windows, `resolve()` returns `C:\path\to\dir`
- The glob library struggles with backslashes
- Converting to `C:/path/to/dir` works cross-platform
- Node.js supports forward slashes on all platforms

### Additional Enhancements: Debug Logging

Added comprehensive debug output to `getInputFiles()`:

```typescript
console.log('[DEBUG] Config dirs:', this.config.dirs);
console.log('[DEBUG] Working dir:', this.config.workingDir);
console.log('[DEBUG] Dir resolved to:', normalizedDir);
console.log('[DEBUG] Glob patterns:', patterns);
console.log(`[DEBUG] Glob matched ${result.length} files`);
```

This helps diagnose any remaining issues on Windows.

## Files Modified

1. **`packages/cli/src/lib/builders/base-builder.ts`**
   - `getInputFiles()`: Normalize paths for glob patterns
   - Added debug logging
   
2. **`packages/builders/src/base-builder.ts`**
   - Same changes as above

## What Was Already Fixed (Previous Session)

1. **Import statement paths** - Already normalized to use `/`
2. **Virtual entry file generation** - Already uses normalized paths
3. **Enhanced debug output** - Added `.workflow-manifest-debug.json` files

## Testing on Windows

### Before Testing
```powershell
cd workbench\nextjs-turbopack
Remove-Item -Recurse -Force app\.well-known
```

### Run Build
```powershell
npm run build
```

### Expected Output
```
Discovering workflow directives Xms
Created steps bundle Xms
[DEBUG] Discovered workflow files (4):
[ './workflows/6_batching.ts', './workflows/98_duplicate_case.ts', ... ]
DEBUG: Writing workflow manifest with 4 workflows
```

### Check Debug File
```powershell
Get-Content "app\.well-known\workflow\v1\flow\.workflow-manifest-debug.json"
```

Should show `workflowCount: 4` (or your project's workflow count)

## Verification on macOS

✅ **Confirmed working** - Build shows 4 workflows as expected
✅ **No regressions** - All paths properly normalized
✅ **Debug output** - All debug logs capture expected values

## Expected Windows Results After Fix

| Metric | Before | After |
|--------|--------|-------|
| Workflows discovered | 0 | 4 (or your project's count) |
| Console output | "0 workflows" | "4 workflows" |
| Debug file count | 0 | 4 |
| Build status | Incomplete | ✅ Complete |

## How to Validate the Fix

1. **Run on Windows** with the updated code
2. **Compare console output** - Should match macOS (same workflow count)
3. **Check debug file** - Should have non-zero workflow count
4. **Verify routes generated** - Should see `.well-known/workflow/v1/flow/route.js` created

## If Issues Persist

If you still see 0 workflows on Windows after this fix:

1. **Check config** - Ensure `Config dirs` are correct
2. **Verify paths** - Check that `Dir resolved to` shows `/` not `\`
3. **List files** - Manually verify workflow files exist in those directories
4. **Check patterns** - Ensure glob patterns show normalized paths
5. **Debug output** - Share the `[DEBUG]` lines for analysis

## Timeline of Fixes

1. **Session 1**: Added debug logging and fixed import paths
2. **Session 2**: Fixed glob pattern path normalization (THIS CHANGE)

## Key Insight

The issue wasn't in how workflows are processed, but in how the **glob library discovers files** on Windows. By normalizing paths to use forward slashes before passing them to glob, we work around the Windows path separator issue.

This is a **minimal, focused fix** that solves the root cause without breaking existing functionality.
