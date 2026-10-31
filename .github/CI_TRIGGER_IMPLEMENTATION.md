# CI Trigger Implementation for External PRs

## Overview

This implementation solves the problem of CI not running for external contributor PRs due to GitHub Actions security restrictions that prevent access to repository secrets.

## Files Created

### 1. `.github/workflows/trigger-ci.yml`

**Purpose:** Main workflow that triggers CI for external PRs

**Trigger:** `issue_comment` event with `/run-ci` command

**Key Features:**
- Permission check: Verifies commenter has admin or write access
- Fetches external PR branch from fork
- Creates a new branch in main repo (pattern: `ci-test/{pr-number}-{timestamp}`)
- Creates a draft PR that triggers all existing CI workflows
- Comments on original PR with status
- Adds labels: `ci-test`, `automated`

**Security:**
- Only admin/write access users can trigger
- Fails gracefully with clear error message for unauthorized users
- Comments on PR to notify unauthorized attempts

### 2. `.github/workflows/cleanup-ci-test-prs.yml`

**Purpose:** Automatic cleanup of CI test PRs

**Trigger:** `workflow_run` event when "Tests" workflow completes

**Key Features:**
- Detects CI test branches (prefix: `ci-test/`)
- Comments on CI test PR with results (✅ or ❌)
- Closes the draft PR automatically
- Deletes the temporary branch
- Comments on original PR with final results
- Links to full test run

### 3. `.github/EXTERNAL_PR_CI.md`

**Purpose:** Comprehensive documentation for the feature

**Contents:**
- Problem statement
- Solution explanation
- How-to guide for admins
- Workflow details
- Security considerations
- Troubleshooting guide
- Limitations

### 4. Updated `README.md`

**Purpose:** Inform external contributors about the process

**Changes:**
- Added "For External Contributors" section
- Links to detailed documentation
- Explains that maintainers will trigger CI

## How It Works

### Flow Diagram

```
1. External Contributor submits PR
   ↓
2. Admin reviews code
   ↓
3. Admin comments "/run-ci" on PR
   ↓
4. trigger-ci.yml workflow runs:
   - Checks admin permissions ✓
   - Fetches external branch
   - Creates ci-test branch
   - Creates draft PR
   - Comments on original PR
   ↓
5. All CI workflows run on draft PR
   (with full access to secrets)
   ↓
6. Tests complete (success or failure)
   ↓
7. cleanup-ci-test-prs.yml workflow runs:
   - Comments on draft PR with results
   - Closes draft PR
   - Deletes ci-test branch
   - Comments on original PR with results
```

## Testing the Implementation

### Test Scenario 1: Authorized User

1. Create a test PR from a fork (or ask an external contributor)
2. Comment `/run-ci` on the PR as an admin
3. Expected results:
   - New draft PR created with title `[CI Test] {original title}`
   - Comment appears on original PR with success message
   - CI workflows start running on draft PR
   - After CI completes, draft PR is closed
   - Original PR receives comment with results

### Test Scenario 2: Unauthorized User

1. Create a test PR from a fork
2. Comment `/run-ci` on the PR as a non-admin user
3. Expected results:
   - Comment appears: "❌ Only repository admins..."
   - No draft PR created
   - Workflow fails with permission error

### Test Scenario 3: Not a PR Comment

1. Comment `/run-ci` on an issue (not a PR)
2. Expected results:
   - Workflow doesn't run (filtered by `if` condition)

### Test Scenario 4: CI Cleanup

1. After a CI test PR completes:
2. Expected results:
   - Draft PR gets comment with ✅ or ❌ status
   - Draft PR is automatically closed
   - Branch `ci-test/{number}-{timestamp}` is deleted
   - Original PR receives comment with results link

## Security Considerations

### Why This Is Safe

1. **Permission Gating:** Only admin/write users can trigger
2. **Code Review Required:** Admins must manually review before triggering
3. **Audit Trail:** All actions are logged in PR comments
4. **Isolated Branches:** Each test uses a unique branch name
5. **Automatic Cleanup:** Temporary branches are deleted after use

### Risks to Be Aware Of

1. **Secret Exposure:** Malicious code in external PR could attempt to exfiltrate secrets
   - Mitigation: Admins MUST review code before triggering
2. **Resource Usage:** Multiple CI runs increase GitHub Actions minutes
   - Mitigation: Only trigger when necessary
3. **Branch Spam:** Could create many branches if used excessively
   - Mitigation: Automatic cleanup workflow

## Workflow Permissions

Both workflows use these permissions:
```yaml
permissions:
  contents: write      # Create branches, delete branches
  pull-requests: write # Create PRs, update PRs
  issues: write        # Create comments
```

## Integration with Existing CI

The implementation works seamlessly with existing CI:
- All existing workflows in `tests.yml` run on the draft PR
- E2E tests have access to secrets (VERCEL_LABS_TOKEN, etc.)
- Vercel deployments trigger automatically
- Results are reported back to original PR

## Future Enhancements

Potential improvements:
1. Add `/cancel-ci` command to stop running tests
2. Support for re-running specific failed jobs
3. Automatic retry on flaky test failures
4. Status checks on original PR that mirror draft PR status
5. Configurable retention period for CI branches
6. Support for multiple CI runs per PR with history

## Troubleshooting

### Common Issues

**Issue:** Branch already exists error
- **Cause:** Timestamp collision (very rare)
- **Solution:** Wait 1 second and retry `/run-ci`

**Issue:** Cannot fetch external branch
- **Cause:** Fork is private or deleted
- **Solution:** Ask contributor to make fork public

**Issue:** Draft PR not created
- **Cause:** Base branch protected, insufficient permissions
- **Solution:** Check GitHub Actions logs for specific error

## Monitoring

To monitor usage:
1. Check Actions tab for "Trigger CI for External PRs" runs
2. Search for PRs with label `ci-test`
3. Review comments from `github-actions` bot

## Maintenance

### Updating the Workflows

If you need to modify the workflows:
1. Test changes on a fork first
2. Be careful with permissions
3. Update this documentation

### Dependencies

The workflows depend on:
- `actions/checkout@v4`
- `actions/github-script@v7`
- `git` command-line tool (built-in)

## Questions?

For questions or issues with this implementation:
- Open a GitHub Discussion
- Create an issue with label `ci-automation`
- Contact the repository maintainers

