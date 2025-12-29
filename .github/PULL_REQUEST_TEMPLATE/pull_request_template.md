### Description

<!--
  ✍️ Write a short summary of your work. Screenshots and videos are welcome!
-->

### How did you test your changes?

<!--
  ✍️ Provide information about which parts of your changes are covered by tests,
  what the reasoning behind your tests was, and which manual flows you went through.
  For observability (CLI/web/web-shared) changes, showing a screenshot/video and mentioning test data used is often sufficient.
  For builder changes, building the related workbench app and showing it compiles and runs correctly is often sufficient.
  For world, runtime, core, etc. changes, test files are required.
-->

### PR Checklist - Required to merge

- [ ] 📦 `pnpm changeset` was run to create a changelog for this PR
  - During beta, we only use "patch" mode for changes. Don't tag minor/major versions.
  - Use `pnpm changeset --empty` if you are changing documentation or workbench apps
- [ ] 🔒 DCO sign-off passes (run `git commit --signoff` on your commits)
