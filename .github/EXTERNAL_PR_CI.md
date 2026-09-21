# Running CI for External Contributor PRs

## Problem

When external contributors (non-members) submit pull requests, GitHub Actions has security restrictions that prevent:

1. Vercel deployments from automatically running
2. Secret environment variables (like `VERCEL_LABS_TOKEN`, `TURBO_TOKEN`) from being injected into workflows

This means E2E tests and other CI checks that depend on these secrets will fail or not run at all.

## Solution

We've implemented a `/run-ci` command that repository admins can use to trigger CI for external PRs.

## How It Works

### For Repository Admins

When an external contributor submits a PR:

1. Review the PR code for any malicious content (this is important for security!)
2. Comment `/run-ci` on the PR
3. The workflow will:
   - Verify you have admin/write permissions
   - Create a new branch in the main repository based on the external PR's branch
   - Create a draft PR from that branch
   - Run all CI checks with full access to secrets
4. Once CI completes, you'll get a notification on the original PR with the results
5. The draft PR will be automatically closed and the branch deleted

### Workflow Details

**Trigger Workflow** (`.github/workflows/trigger-ci.yml`):
- Triggered by: PR comments containing `/run-ci`
- Permissions required: Admin or Write access
- Creates: A draft PR with the naming pattern `[CI Test] {original PR title}`
- Labels: `ci-test`, `automated`

**Cleanup Workflow** (`.github/workflows/cleanup-ci-test-prs.yml`):
- Triggered by: Completion of the "Tests" workflow
- Automatically closes CI test PRs
- Deletes the temporary CI test branches
- Comments on both the CI test PR and original PR with results

## Security Considerations

⚠️ **Important Security Notes:**

1. **Only admins/maintainers should trigger CI** - The `/run-ci` command requires admin or write permissions
2. **Review code before triggering** - Always review the PR code before running CI, as it will have access to repository secrets
3. **Malicious code risk** - External PRs could contain malicious code that attempts to exfiltrate secrets
4. **Branch protection** - The main branch should have branch protection rules enabled

## Example Usage

```markdown
Comment on PR #123:

/run-ci
```

Response:

```markdown
✅ CI test triggered by @admin-username!

CI is now running in draft PR #456. You can monitor the progress there.

Once the tests complete, you can review the results and the draft PR will be automatically closed.
```

## Branch Naming Convention

CI test branches follow the pattern:
```
ci-test/{original-pr-number}-{timestamp}
```

Example: `ci-test/123-1699876543210`

## Troubleshooting

### "Insufficient permissions" error

Only repository admins and members with write access can trigger CI. If you see this error, you don't have the required permissions.

### CI test PR not created

1. Check that the comment was on a pull request (not an issue)
2. Verify the exact text `/run-ci` was in the comment
3. Check the GitHub Actions logs for the "Trigger CI for External PRs" workflow

### Branch conflicts

If the external PR's branch has conflicts with the base branch, the CI test PR will also have those conflicts. The contributor should resolve conflicts in their original PR first.

## Limitations

1. The external contributor's branch must be accessible (public fork or within the same organization)
2. CI tests will run against the code at the time `/run-ci` was triggered. If the contributor pushes new commits, you'll need to run `/run-ci` again
3. Only one CI test can be running per PR at a time (subsequent `/run-ci` commands will create new test PRs)

