# Pull Requests

## When to Use

Use when a change affects what `packages/web` or `packages/web-shared` looks like, and when opening or updating a PR that changes either package. Read it before you change the code: the before screenshots have to be captured first.

## Required Patterns

### Preview Link

Add a "Preview" section to the PR description, after the Why, with a direct link to the change on the `workflow-web` preview deployment, followed by step-by-step instructions for checking it there:

- Build the URL from the branch name: lowercase it, replace every character other than `a-z` and `0-9` with `-`, and use `https://workflow-web-git-<branch-slug>.labs.vercel.dev`. For example, `web-shared/search-input` becomes `https://workflow-web-git-web-shared-search-input.labs.vercel.dev`.
- Vercel shortens long branch slugs, so once the `vercel[bot]` comment appears on the PR, compare the link with the Preview link in its `workflow-web` row and use that one if they differ.
- Link to the page that shows the change: the home page (`/`, with `?tab=runs`, `hooks` or `workflows`) or a run (`/run/<runId>`, with `?tab=trace`, `events`, `streams` or `graph`).
- The preview deployment sits behind deployment protection, so the link requires Vercel team access. This is expected; include it anyway for reviewers.

### Before and After Screenshots

When you can, add before and after screenshots of each changed surface, after the Preview section. Attach them with the [`before-and-after`](https://github.com/vercel-labs/before-and-after) skill (`npx skills add vercel-labs/before-and-after#main`), which needs `agent-browser` and GitHub CLI 2.99 or later for `gh pr edit --attach`.

- Capture the before state before you change the code, at the same viewport, theme, and data as the after state.
- When the change affects colour or styling, capture both themes. When it changes a state other than the default (loading, empty, error, long content), capture that state. For an interaction or transition, attach a short recording.
- Review every capture before uploading it. Never publish one that shows tokens, cookies, bypass secrets, or customer data.
- If you cannot attach the captures, tell the person you are working with where you saved them.

## Rationale

Reviewers judge a UI change by looking at it. The preview link lets them try it; before and after pairs show what changed without checking out the branch, and stay on the PR after the preview deployment is gone.

## Related Guidance

- [Validation](../validation/GUIDE.md) lists the states and themes to render while working.
