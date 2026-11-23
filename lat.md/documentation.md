# Documentation

Documentation standards cover package READMEs, public SDK docs and compiler specifications.

## Documentation standards

Package READMEs and public SDK documentation must describe their audience and current behavior accurately.

- README.md files in each package must accurately reflect the current functionality and purpose of that package
- READMEs should not contain outdated or incorrect information about package capabilities
- When modifying package functionality, ensure corresponding README updates are included
- Document every user-configurable environment variable in the docs. The docs describe spec 9 runs (the default since v5.8.0) as the default behaviour, without naming the spec version. Where a spec 8 run (created before v5.8.0, on a World without the in-band fence, or with `WORKFLOW_SPEC_VERSION=8`) behaves differently, add a `<Spec8Note>` right after the default description; its children continue the fixed lead sentence, so start them in lowercase, keep them self-contained (no pronoun pointing outside the note), and never place the note right next to another callout. [[docs/lib/remark-spec8-note.ts|`docs/lib/remark-spec8-note.ts`]] expands it into a callout. Never add per-version sections. In `configuration/runtime-tuning.mdx`, orchestrator-only settings go in the Orchestrator section and the rest in the topic sections, each with a `<Spec8Note>` if spec 8 reads it differently or not at all. How each runtime works inside lives in its design note (for spec 9, [[packages/core/src/runtime/spec9/README.md|`packages/core/src/runtime/spec9/README.md`]]); [[docs/content/worlds/|`docs/content/worlds/`]] may name spec versions where it describes what a World implements to support them.
- Write docs as a description of how things work now, not as a changelog: no "no longer", "now", "was added", or history of past behavior. That belongs in changesets and PR descriptions. Keep pages short; don't add explanation the reader doesn't need to act.
- Docs pages never reference or link to source files in this repository. Design notes for maintainers live as markdown next to the code they describe (see [[architecture#Architecture#Workflow execution model|Workflow execution model]]) and are referenced from source comments.
- The docs site is public: everything under [[docs/content/|`docs/content/`]] is published on workflow-sdk.dev, indexed by search engines, and served to agents through site search, `llms.txt` and the docs MCP. Write it only for people who use the SDK or build a World. Design notes, RFCs, implementation references and anything else aimed at maintainers go next to the code, never into a docs page. There is no `/docs/changelog` section; release notes come from changesets (rendered at `/changelog`).
- Preview-only tooling pages go in a docs tree's `internal/` folder with `internal: true` frontmatter, which makes production answer 404 for them, keeps them out of the sidebar, sitemap, search, `llms.txt` and chat, and marks them `noindex`. Public pages never link to them.
- `pnpm --filter docs lint:links` (the Docs Links CI job) enforces the three rules above. When a page leaves the site, add a redirect in [[docs/next.config.ts|`docs/next.config.ts`]].
- When modifying skill files in [[skills/|`skills/`]], always bump the `version` field in the frontmatter metadata
- [[skills/|`skills/`]] holds skills published for SDK users. Skills for contributors working in this repository live in [[.agents/skills/|`.agents/skills/`]] and are not published. Read [[.agents/skills/web-guidelines/SKILL.md|`web-guidelines`]] before changing [[packages/web|`packages/web`]] or [[packages/web-shared|`packages/web-shared`]].

## SWC plugin

When modifying the SWC compiler plugin ([[packages/swc-plugin-workflow|`packages/swc-plugin-workflow`]]), you must also update the specification document at [[packages/swc-plugin-workflow/spec.md|`packages/swc-plugin-workflow/spec.md`]] to reflect any changes to the transformation behavior.
