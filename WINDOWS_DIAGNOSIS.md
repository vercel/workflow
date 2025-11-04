# Windows Workflow Discovery - Additional Diagnosis

## Current Status

The issue on Windows is that **0 files are being discovered in the glob phase**, not in the manifest building phase.

Output on Windows:
```
[DEBUG] Discovered workflow files (0): []
```

This means the glob pattern is not matching any files. The issue is likely one of:
1. Working directory is incorrect on Windows
2. Config directories are not set correctly
3. Glob patterns have issues with Windows paths

## New Debug Information Added

We've added enhanced debugging to show:
- `Config dirs` - What directories are being searched
- `Working dir` - The base directory 
- `Dir resolved to` - The actual resolved path for each directory
- `Glob patterns` - The final glob patterns being used
- `Glob matched X files` - How many files the glob found

## Next Steps for Windows Testing

1. **Run build and capture debug output:**
   ```bash
   npm run build 2>&1 | Select-String "DEBUG" | Tee-Object -FilePath windows-debug.log
   ```

2. **Share the output, particularly:**
   - `[DEBUG] Config dirs:` - What directories are configured?
   - `[DEBUG] Working dir:` - What is the working directory?
   - `[DEBUG] Dir "X" resolved to:` - Are the paths correct?
   - `[DEBUG] Glob patterns:` - Do the patterns look right?
   - `[DEBUG] Glob matched X files:` - How many files were found?

## Likely Issues to Check

### Issue 1: Wrong Working Directory
If `[DEBUG] Working dir:` is incorrect (not the project root), workflows won't be found.

**Fix**: Ensure you're running the build from the correct directory:
```bash
cd workbench\nextjs-turbopack
npm run build
```

### Issue 2: Directory Names Don't Exist
If the resolved directories don't exist on Windows, glob will match 0 files.

**Check**: Compare `[DEBUG] Dir resolved to:` with actual directory structure:
```bash
# List what glob is looking for
dir "path\from\debug\output"
```

### Issue 3: Glob Pattern Issues
If the glob patterns have issues (mixed separators, etc.), they won't match.

**Check**: The `[DEBUG] Glob patterns:` should look like:
```
[
  "C:/path/to/workflows/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "C:/path/to/app/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  ...
]
```

Notice: All separators should be `/`, not `\`

### Issue 4: Directories Not in Config
If the workflow directories are named differently (e.g., `workflows` vs `Workflows`), they won't be found.

**Check**: Look at `.well-known/workflow/v1/flow/route.js` - what directories should contain workflows?

## Expected Output on Windows

After the fix, Windows output should show:
```
[DEBUG] Config dirs: [ 'pages', 'app', 'src/pages', 'src/app' ]
[DEBUG] Working dir: C:\Users\...\nextjs-turbopack
[DEBUG] Dir "pages" resolved to: C:/Users/.../nextjs-turbopack/pages
[DEBUG] Dir "app" resolved to: C:/Users/.../nextjs-turbopack/app
[DEBUG] Dir "src/pages" resolved to: C:/Users/.../nextjs-turbopack/src/pages
[DEBUG] Dir "src/app" resolved to: C:/Users/.../nextjs-turbopack/src/app
[DEBUG] Glob patterns: [
  "C:/Users/.../nextjs-turbopack/pages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "C:/Users/.../nextjs-turbopack/app/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  ...
]
[DEBUG] Glob matched 47 files
[DEBUG] First few matches: [
  "C:/Users/.../nextjs-turbopack/app/page.tsx",
  "C:/Users/.../nextjs-turbopack/app/layout.tsx",
  ...
]
[DEBUG] Discovered workflow files (4):
[ './workflows/6_batching.ts', './workflows/98_duplicate_case.ts', ... ]
```

## What We Fixed So Far

1. **Import path normalization**: File paths in `import` statements now use `/` instead of `\`
2. **Virtual entry file generation**: Both steps and workflows now normalize paths
3. **Glob pattern normalization**: Glob patterns now use `/` instead of `\`

## How to Report the Issue

If you're still seeing 0 workflows on Windows, please share:

1. The complete debug output with `[DEBUG]` lines
2. Your project directory structure:
   ```bash
   dir /s /b app\*workflow*
   dir /s /b workflows /R
   ```
3. The config being used (from `getInputFiles` debug output)
4. Your Node/npm versions:
   ```bash
   node --version
   npm --version
   ```

This information will help identify the exact cause on Windows.
