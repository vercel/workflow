# Windows Build Testing Guide

## Quick Start

After the Windows path normalization fix, test your build on Windows with these steps:

### 1. Clean Previous Build
```bash
cd workbench/nextjs-turbopack
rm -r app\.well-known
```

### 2. Run Build
```bash
npm run build
```

### 3. Check Console Output
Look for these lines in the build output (scroll up if needed):
```
[DEBUG] Discovered workflow files (4):
[ './workflows/6_batching.ts', './workflows/98_duplicate_case.ts', ... ]
Created intermediate workflow bundle Xms
[DEBUG] Manifest has 4 workflow entries from 4 files
[DEBUG] Workflow files in manifest:
[ 'workflows/6_batching.ts', 'workflows/98_duplicate_case.ts', ... ]
DEBUG: Writing workflow manifest with 4 workflows
```

### 4. Verify Debug Files Created
Check that these files exist and contain data:
```bash
# Check if files were created
dir "app\.well-known\workflow\v1\flow\*.debug.json"

# View the manifest debug file
type "app\.well-known\workflow\v1\flow\.workflow-manifest-debug.json"
```

### 5. Expected Output
The `.workflow-manifest-debug.json` file should show:
```json
{
  "timestamp": "2025-11-04T01:01:01.947Z",
  "workflowCount": 4,
  "discoveredWorkflowFiles": [
    "C:\\path\\to\\workflows\\6_batching.ts",
    "C:\\path\\to\\workflows\\98_duplicate_case.ts",
    "C:\\path\\to\\workflows\\99_e2e.ts",
    "C:\\path\\to\\workflows\\streams.ts"
  ],
  "manifestWorkflowFiles": [
    "workflows/6_batching.ts",
    "workflows/98_duplicate_case.ts",
    "workflows/99_e2e.ts",
    "workflows/streams.ts"
  ],
  "workflows": [
    "workflows/6_batching.ts",
    "workflows/98_duplicate_case.ts",
    "workflows/99_e2e.ts",
    "workflows/streams.ts"
  ]
}
```

## Troubleshooting

### Problem: Still showing 0 workflows on Windows

#### Step 1: Verify discover phase
Check the `discoveredWorkflowFiles` array in the debug JSON:
- **If empty**: Issue is in discovery phase (workflow files not found)
- **If populated**: Issue is in manifest building phase (workflows not being recognized)

#### Step 2: Check for file path issues
```bash
# PowerShell - List discovered workflow files
Get-Content "app\.well-known\workflow\v1\flow\.workflow-manifest-debug.json" | ConvertFrom-Json | Select-Object -ExpandProperty discoveredWorkflowFiles
```

Look for:
- Mixed path separators (some `\`, some `/`) → still has backslashes
- Absolute paths being stored → should be relative
- Files that don't exist → permissions or glob issue

#### Step 3: Verify build output  
```bash
npm run build 2>&1 > build.log
findstr /i "debug\|discovered\|manifest\|workflow" build.log | more
```

### Problem: Workflows still not appearing in production build

1. Check the manifest file:
```bash
type "app\.well-known\workflow\v1\flow\manifest.debug.json"
```

2. Verify route file was created:
```bash
dir "app\.well-known\workflow\v1\flow\route.js"
type "app\.well-known\workflow\v1\flow\route.js" | more
```

3. Check for SWC transform errors in build output

## Comparing Windows vs macOS

After running on both systems, the files should be identical except for:

### Path separators in `discoveredWorkflowFiles`:
- **Windows**: `C:\absolute\path\to\workflow.ts` (backslashes)
- **macOS**: `/absolute/path/to/workflow.ts` (forward slashes)

### All other fields should be identical:
- `workflowCount` should match
- `manifestWorkflowFiles` should be identical (normalized to forward slashes)
- `workflows` should be identical (normalized to forward slashes)
- `.well-known/workflow/v1/flow/manifest.debug.json` content should be identical

## Additional Debug Commands

### View full build output with timestamps
```bash
npm run build 2>&1 | Tee-Object -FilePath build-$(Get-Date -Format 'yyyyMMdd-HHmmss').log
```

### Search for specific debug messages
```bash
npm run build 2>&1 | Select-String "DEBUG|warning|error"
```

### Check if workflows are being correctly imported
```bash
npm run build 2>&1 | Select-String "import \* as workflowFile"
```

## Expected Results

✅ **Success**: 
- Console shows correct workflow count
- Debug files contain populated `discoveredWorkflowFiles`
- Debug files contain non-empty `manifestWorkflowFiles`
- All paths use forward slashes in `manifestWorkflowFiles`

❌ **Failure**:
- Console shows "DEBUG: Writing workflow manifest with 0 workflows"
- Debug file has empty `discoveredWorkflowFiles` array
- Debug file has empty `manifestWorkflowFiles` array

## Next Steps

If you're still experiencing issues:

1. Compare the debug output from Windows and macOS
2. Share the `.workflow-manifest-debug.json` file
3. Share the build console output (especially the [DEBUG] lines)
4. Mention your Node.js version on Windows: `node --version`
5. Mention your npm/pnpm version: `npm --version`

This will help diagnose any remaining cross-platform issues.
