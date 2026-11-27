# Agent instructions

**CRITICAL RULES:**
- NEVER push directly to the `main` or `stable` branches
- Do not remove or break agent-discoverable docs sitemap behavior: keep docs/app/sitemap.md/route.ts and docs/app/[lang]/sitemap.md/route.ts, and keep the sitemap link in docs/app/[lang]/llms.mdx/[[...slug]]/route.ts.

## Knowledge and required reading

Project knowledge lives in [lat.md/](lat.md/lat.md). Read the relevant topic before changing behavior and update its authoritative document in the same change.

| Task | Read first |
| --- | --- |
| Architecture, execution contexts, package responsibilities | [Architecture](lat.md/architecture.md) |
| Runtime replay or delivery behavior | The code-adjacent notes listed in [Workflow execution model](lat.md/architecture.md#workflow-execution-model) |
| Workspace commands, workbenches, build conventions or Lat setup | [Development](lat.md/development.md) |
| Package tests or local/deployed E2E setup | [Testing](lat.md/testing.md) |
| Event-log race harness, scale or CI results | [Event log race repro](lat.md/event-log-race-repro.md) |
| Bundle measurements or their CI gate | [Bundle size](lat.md/bundle-size.md) |
| Public docs, maintainer docs or SDK skills | [Documentation](lat.md/documentation.md) |
| Opening or updating a PR | [Pull requests](lat.md/pull-requests.md) |
| Release automation, changesets, backports or npm tags | [Releases](lat.md/releases.md) |
| Rust crates, bindings or Rust Worlds | [Rust](lat.md/rust/rust.md), then the plan or component document it lists |

Repository rules outside the `lat:begin` / `lat:end` markers are maintained here. Lat owns only its marked block and the generated [authoring skill](.agents/skills/lat-md/SKILL.md). Keep project knowledge in `lat.md/` and leave generated templates intact.

Local Lat embeddings need no API key. If search is unavailable, use `lat locate` / `lat section` or read the files above; follow [setup](lat.md/development.md#knowledge-graph-setup) to select a local or hosted backend.

%% lat:begin %%
# Before starting work

Use Lat's knowledge graph to ground each task before changing code.

- Run `lat search` to find sections relevant to your task. Read them to understand the design intent before writing code.

# Post-task checklist (REQUIRED — do not skip)

After EVERY task, before responding to the user:

- [ ] Update `lat.md/` if you added or changed meaningful implemented functionality, architecture, tests, or behavior. Keep it a focused snapshot of the current implemented state, not a journal/changelog. Plans may be drafted in `lat.md/` alongside implementation, with the intent that by commit time they describe what was implemented. Otherwise, keep proposals, hypothetical designs, and future work outside `lat.md/` unless the user explicitly requests them there.
- [ ] Run `lat check` — all validations must pass
- [ ] Do not skip these steps. Do not consider your task done until both are complete.

---

# What is lat.md?

Lat.md is the project's structured knowledge graph for architecture, design decisions, behavior, and tests.

The graph lives in `lat.md/` as cross-linked Markdown describing **what** the project does and **why**. Use it to ground work in actual architecture, and keep it a focused snapshot of the current implemented state rather than a journal or changelog.

Project-specific lat documentation belongs in `lat.md/`. Do not modify this generated instruction file or a generated `lat-md` `SKILL.md` to record project guidance: both are owned by lat tooling and may be replaced by a later `lat init`.

# Commands

Use these commands to navigate and validate the project knowledge graph.

```bash
lat locate "Section Name"      # find a section by name (exact, fuzzy)
lat refs "file#Section"        # find what references a section
lat search "natural language"  # semantic search across all sections
lat external show <handle>      # inspect a pinned external source before cloning it
lat check                      # run full graph and documentation validation
```

Run `lat --help` when in doubt about available commands or options.

If `lat search` fails because no API key is configured, explain to the user that semantic search requires a key provided via `LAT_LLM_KEY` (direct value), `LAT_LLM_KEY_FILE` (path to key file), or `LAT_LLM_KEY_HELPER` (command that prints the key). Supported key prefixes: `sk-...` (OpenAI) or `vck_...` (Vercel). If the user doesn't want to set it up, use `lat locate` for direct lookups instead.

# Syntax primer

Lat uses stable section ids, wiki links, source links, and code references to connect documentation with implementation.

- **Section ids**: `lat.md/path/to/file#Heading#SubHeading` — full form uses project-root-relative path (e.g. `lat.md/tests/search#RAG Replay Tests`). Short form uses bare file name when unique (e.g. `search#RAG Replay Tests`, `cli#search#Indexing`).
- **Wiki links**: `[[target]]` or `[[target|alias]]` — cross-references between sections. Can also reference repository paths or source code: `[[schema.sql]]`, `[[src/components]]`, `[[src/foo.ts#myFunction]]`.
- **Link specificity**: When documenting implemented behavior, prefer the narrowest relevant source-symbol link over a whole-file link. Use whole-file or directory links when discussing the module or resource as a whole, or when no supported symbol represents the target. If prose names a symbol, link that symbol directly.
- **Repository path links**: Wiki links without a `#` fragment may target any existing file or directory inside the project. Unsupported formats validate but cannot be opened by Lat; fragments require a `lat.md/` section or supported source file.
- **Source code links**: Wiki links in `lat.md/` files can reference functions, classes, constants, and methods in supported source files. Use the full path: `[[src/config.ts#getConfigDir]]`, `[[src/server.ts#App#listen]]` (class method), `[[lib/utils.py#parse_args]]`, `[[src/lib.rs#Greeter#greet]]` (Rust impl method), `[[src/app.go#Greeter#Greet]]` (Go method), `[[src/app.h#Greeter]]` (C struct). When prose names an implementation symbol or a behavior governed by one, link the symbol instead of using a bare code span or copying its literal value. Prefer `[[src/config.ts#DEFAULT_TIMEOUT]]` (or an aliased form) over a bare identifier or copied value. `lat check` validates these exist.
- **Code refs**: `// @lat: [[section-id]]` (JS/TS/Rust/Go/C/PHP) or `# @lat: [[section-id]]` (Python/PHP) — ties source code to concepts

# Diagrams

Default to prose. Reserve Mermaid diagrams for concepts involving more than seven interacting subjects (such as components, states, or stages) with complex sequencing, branching, or dependencies that prose alone makes hard to follow.

The subject count alone does not justify a diagram; omit diagrams for simple sequences or relationships that a short paragraph or list explains clearly. A diagram should give users and later agents an overview of the interactions.

Keep each diagram focused on one process, use readable labels, and explain the important decisions in surrounding prose with precise source-symbol links. Prefer a small overview or several focused diagrams over one dense diagram. Use fenced `mermaid` blocks and run `lat check` to validate syntax and readability.

# Test specs

Key tests can be described as sections in `lat.md/` files (e.g. `tests.md`). Add frontmatter to require that every leaf section is referenced by a `// @lat:` or `# @lat:` comment in test code:

```markdown
---
lat:
  require-code-mention: true
---
# Tests

Authentication and authorization test specifications.

## User login

Verify credential validation and error handling for the login endpoint.

### Rejects expired tokens
Tokens past their expiry timestamp are rejected with 401, even if otherwise valid.

### Handles missing password
Login request without a password field returns 400 with a descriptive error.
```

Every section MUST have a description — at least one sentence explaining what the test verifies and why. Empty sections with just a heading are not acceptable. (This is a specific case of the general leading paragraph rule below.)

Each test in code should reference its spec with exactly one comment placed next to the relevant test — not at the top of the file:

```python
# @lat: [[tests#User login#Rejects expired tokens]]
def test_rejects_expired_tokens():
    ...

# @lat: [[tests#User login#Handles missing password]]
def test_handles_missing_password():
    ...
```

Do not duplicate refs. One `@lat:` comment per spec section, placed at the test that covers it. `lat check` will flag any spec section not covered by a code reference, and any code reference pointing to a nonexistent section.

# Section structure

Concise opening paragraphs give every section a stable overview for validation and discovery.

Every section in `lat.md/` **must** have a leading paragraph — at least one sentence immediately after the heading, before any child headings or other block content. The first paragraph must be ≤250 characters (excluding `[[wiki link]]` content). This paragraph serves as the section's overview and is used in search results, command output, and RAG context — keeping it concise guarantees the section's essence is always captured.

```markdown
# Good Section

Brief overview of what this section documents and why it matters.

More detail can go in subsequent paragraphs, code blocks, or lists.

## Child heading

Details about this child topic.
```

```markdown
# Bad Section

## Child heading

Details about this child topic.
```

The second example is invalid because `Bad Section` has no leading paragraph. `lat check` validates this rule and reports errors for missing or overly long leading paragraphs.
%% lat:end %%
