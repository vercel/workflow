# Pull requests

When opening a pull request, always use the [[.github/PULL_REQUEST_TEMPLATE/pull_request_template.md|template]] and follow the agent instructions in its trailing comment.

## Docs preview links in PR descriptions

When a PR adds or updates docs pages (anything under [[docs/content/|`docs/content/`]]), add a "Docs Preview" section to the PR description with direct links to each changed page on the `workflow-docs` preview deployment:

- Get the preview base URL from the `vercel[bot]` comment on the PR. Use the Preview link from the `workflow-docs` project row (e.g. `https://workflow-docs-git-<branch-slug>.vercel.sh`). Don't construct the URL by hand because Vercel's branch-slug normalization is not a direct substitution.
- Map content paths to routes: `docs/content/docs/v5/<path>.mdx` is served at `/docs/<path>` (v5 is the default/latest version) and `docs/content/docs/v4/<path>.mdx` at `/v4/docs/<path>` (v4 is the maintenance version).
- When a change is scoped to a specific section of a page, link to its heading anchor (e.g. `/docs/foundations/hooks#checking-for-token-conflicts`) and verify the anchor matches a real heading in the MDX.
- A table with one row per page (and one column per docs version, when both v4 and v5 were updated) works well.
- The preview deployment sits behind deployment protection, so the links require Vercel team access. This is expected; include them anyway for reviewers.

## Observability UI preview links in PR descriptions

When a PR changes the observability UI ([[packages/web|`packages/web`]] or [[packages/web-shared|`packages/web-shared`]]), add a "Preview" section to the PR description with a direct link to the change on the `workflow-web` preview deployment, followed by step-by-step instructions for checking it there:

- Build the URL from the branch name: lowercase it, replace every character other than `a-z` and `0-9` with `-`, and use `https://workflow-web-git-<branch-slug>.labs.vercel.dev`. For example, `web-shared/search-input` becomes `https://workflow-web-git-web-shared-search-input.labs.vercel.dev`.
- Vercel shortens long branch slugs, so once the `vercel[bot]` comment appears on the PR, compare the link with the Preview link in its `workflow-web` row and use that one if they differ.
- Link to the page that shows the change: the home page (`/`, with `?tab=runs`, `hooks` or `workflows`) or a run (`/run/<runId>`, with `?tab=trace`, `events`, `streams` or `graph`).
- The preview deployment sits behind deployment protection, so the link requires Vercel team access. This is expected; include it anyway for reviewers.
