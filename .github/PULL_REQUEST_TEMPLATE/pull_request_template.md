### What

<!--
  ✍️ A short summary of what this pull request accomplishes. Screenshots and videos are welcome!
-->

### Why

<!--
  ✍️ The motivation for making this change.
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
  - Add one changeset per PR, listing every package it changes. Keep the summary to a sentence or two on what changed for users (see "Writing changesets" in `AGENTS.md`).
  - Use the correct semver bump type: `patch` for bug fixes, `minor` for new features, `major` for breaking changes.
  - Use `pnpm changeset --empty` if you are changing documentation or workbench apps
- [ ] 🔒 DCO sign-off passes (run `git commit --signoff` on your commits)
- [ ] 📝 Ping `@vercel/workflow` in a comment once the PR is ready, and the above checklist is complete

<!--

AGENTS:
- The What and Why should each be 1-3 sentences.
- Write your answers based off of your conversation with the user, not purely based on the changed code
  - It's helpful to understand the reasoning behind an approach, what alternatives were considered, and why this approach was ultimately selected, rather than a summary of the lines changed
- Make the description easy to parse and understand for a reviewer who hasn't seen your conversation:
  - Use plain words and short sentences, and lead with the outcome before the details
  - Break up anything longer than a few sentences with lists, tables, or `####` headings, one idea per item
  - Explain terms and internal names the first time they appear, and put code identifiers in backticks
- If the PR changes docs pages or the observability UI:
  - Add the preview sections described under "Pull requests" in AGENTS.md after the Why
- For complex changes (>1k lines, not counting lockfiles):
  - Add a `### Walkthrough` section after How did you test your changes? which breaks down the primary changes into easy-to-follow `#### Sub-Sections`
- For all changes:
  - Add a line to end that indicates what model you are (e.g. "_Written by Claude Opus 5_")
  - You must also add an empty line above this line

-->
