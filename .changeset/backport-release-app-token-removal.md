---
---

Backport CI changes from `main` to unblock releases on `stable`. Removes the dependency on the temporarily-removed Release App by switching to `secrets.GITHUB_TOKEN` with `commitMode: github-api` for GPG-signed commits, and bumps `pnpm/action-setup` to `v5` so the version is read from `package.json#packageManager`. Backports #1785, #1866, and #1867.
