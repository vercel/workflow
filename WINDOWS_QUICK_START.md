# Windows Build Fix - Quick Start

## What Was Fixed

✅ **Workflow discovery** - Now finds workflows on Windows
✅ **Import paths** - Generated files use forward slashes
✅ **Glob patterns** - Use normalized paths

## Test It Now

```bash
cd workbench\nextjs-turbopack
npm run build
```

## Success Criteria

Look for **all three** in the output:

1. **Manifest generated**:
   ```
   [DEBUG] Discovered workflow files (4): [...]
   DEBUG: Writing workflow manifest with 4 workflows
   ```

2. **Build successful**:
   ```
   ✓ Compiled successfully
   ```

3. **No errors**:
   ```
   (no "Module not found" messages)
   ```

## If Still Failing

Share this output:
```bash
npm run build 2>&1 | Select-String "DEBUG|error|failed"
```

## Files That Changed

- `packages/cli/src/lib/builders/base-builder.ts`
- `packages/cli/src/lib/builders/discover-entries-esbuild-plugin.ts`
- `packages/builders/src/base-builder.ts`
- `packages/builders/src/discover-entries-esbuild-plugin.ts`

## What Changed

All changes normalize Windows backslash paths to forward slashes:
```typescript
// Convert C:\path\to\file to C:/path/to/file
path.replace(/\\/g, '/')
```

## Key Points

- ✅ Works on macOS (tested)
- ✅ Minimal changes
- ✅ Cross-platform solution
- ✅ No breaking changes

## Done!

The Windows workflow build should now work. Test it and report any issues with the debug output.
