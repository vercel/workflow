---
name: lat-md
description: >-
  Writing and maintaining lat.md documentation files — structured markdown that
  describes a project's architecture, design decisions, and test specs. Use when
  creating, editing, or reviewing files in the lat.md/ directory.
---

# lat.md Authoring Guide

This skill covers the syntax, structure rules, and conventions for writing `lat.md/` files. Load it whenever you need to create or edit sections in the `lat.md/` directory.

Project-specific lat documentation belongs in `lat.md/`. Do not modify this generated skill or a generated `AGENTS.md` to record project guidance: both are owned by lat tooling and may be replaced by a later `lat init`.

## What belongs in lat.md

`lat.md/` files describe **what** the project does and **why** — domain concepts, key design decisions, business logic, and test specifications. They do NOT duplicate source code. Think of each section as an anchor that source code references back to.

Treat `lat.md/` as a focused snapshot of the current implemented state. Plans may be drafted in `lat.md/` alongside implementation, with the intent that by commit time they describe what was implemented. Otherwise, keep proposals, hypothetical designs, and future work outside `lat.md/` unless the user explicitly requests them there. A planning-only task does not require a knowledge-graph update. Do not use it as a journal or changelog, and do not grow it just to record insignificant implementation details.

Good candidates for sections:
- Architecture decisions and their rationale
- Domain concepts and business rules
- API contracts and protocols
- Test specifications (what is tested and why)
- Non-obvious constraints or invariants

Bad candidates:
- Step-by-step code walkthroughs (the code itself is the walkthrough)
- Auto-generated API docs (use tools for that)
- Journal/changelog entries for each change
- Proposals, planned features, hypothetical designs, or promises of future behavior, unless explicitly requested by the user or drafted alongside implementation to describe implemented behavior by commit time
- Temporary notes or TODOs
- Insignificant implementation details that do not change the current-state model

## Section structure

Every section **must** have a leading paragraph — at least one sentence immediately after the heading, before any child headings or other block content.

The first paragraph must be ≤250 characters (excluding `[[wiki link]]` content). This paragraph is the section's identity — it appears in search results, command output, and RAG context.

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

This is invalid — "Bad Section" has no leading paragraph.
```

`lat check` enforces this rule.

## Diagrams

Default to prose. Reserve Mermaid diagrams for concepts involving more than seven interacting subjects (such as components, states, or stages) with complex sequencing, branching, or dependencies that prose alone makes hard to follow.

The subject count alone does not justify a diagram; omit diagrams for simple sequences or relationships that a short paragraph or list explains clearly. A diagram should give users and later agents an overview of the interactions.

Keep each diagram focused on one process, use readable labels, and explain the important decisions in surrounding prose with precise source-symbol links. Prefer a small overview or several focused diagrams over one dense diagram. Use fenced `mermaid` blocks and run `lat check` to validate syntax and readability.

## Section IDs

Sections are addressed by file path and heading chain:

- **Full form**: `lat.md/path/to/file#Heading#SubHeading`
- **Short form**: `file#Heading#SubHeading` (when the file stem is unique)

Examples: `lat.md/tests/search#RAG Replay Tests`, `cli#init`, `parser#Wiki Links`.

Configured external sources use `[[handle:path/to/file.md#Heading]]` for
Markdown headings and `[[handle:path/to/file.ts#symbol]]` for supported code
symbols. Run `lat external show <handle>` before cloning an external source;
its output includes the pinned commit and safe checkout suggestions.

## Wiki links

Cross-reference other sections or source code with `[[target]]` or `[[target|alias]]`.

When documenting implemented behavior, prefer the narrowest relevant source-symbol link over a whole-file link. Use whole-file or directory links when discussing the module or resource as a whole, or when no supported symbol represents the target. If prose names a symbol, link that symbol directly.

### Section links

Section links connect related concepts while keeping their stable graph identities explicit.

```markdown
See [[cli#init]] for setup details.
The parser validates [[parser#Wiki Links|wiki link syntax]].
```

### Repository path links

Reference any existing file or directory beneath the project root without a fragment:

```markdown
[[schema.sql]]
[[CHANGELOG]]
[[src/components]]
```

Unsupported formats validate as references but cannot be opened by Lat. A `#fragment` requires a `lat.md/` section or a supported source file.

### Source code links

Reference functions, classes, constants, and methods in source files:

```markdown
[[src/config.ts#getConfigDir]]          — function
[[src/server.ts#App#listen]]            — class method
[[lib/utils.py#parse_args]]             — Python function
[[src/lib.rs#Greeter#greet]]            — Rust impl method
[[src/app.go#Greeter#Greet]]            — Go method
[[src/app.h#Greeter]]                   — C struct
```

When prose names an implementation symbol or a behavior governed by one, link the symbol instead of using a bare code span or copying its literal value. Prefer `[[src/config.ts#DEFAULT_TIMEOUT]]` (or `[[src/config.ts#DEFAULT_TIMEOUT|the default timeout]]`) over a bare identifier or copied value. Keep the behavioral explanation in prose; the link makes its implementation binding navigable and validated.

`lat check` validates that all targets exist.

## Code refs

Tie source code back to `lat.md/` sections with `@lat:` comments:

```typescript
// @lat: [[cli#init]]
export function init() { ... }
```

```python
# @lat: [[cli#init]]
def init():
    ...
```

Supported comment styles: `//` (JS/TS/Rust/Go/C/PHP) and `#` (Python/PHP).

Place one `@lat:` comment per section, at the relevant code — not at the top of the file.

## Test specs

Describe tests as sections in `lat.md/` files. Add frontmatter to require that every leaf section has a matching `@lat:` comment in test code:

```markdown
---
lat:
  require-code-mention: true
---
# Tests

Authentication test specifications.

## User login

Verify credential validation and error handling.

### Rejects expired tokens

Tokens past their expiry timestamp are rejected with 401, even if otherwise valid.

### Handles missing password

Login request without a password field returns 400 with a descriptive error.
```

Each test references its spec:

```python
# @lat: [[tests#User login#Rejects expired tokens]]
def test_rejects_expired_tokens():
    ...
```

Rules:
- Every leaf section under `require-code-mention: true` must be referenced by exactly one `@lat:` comment
- Every section MUST have a description — at least one sentence explaining what the test verifies and why
- `lat check` flags unreferenced specs and dangling code refs

## Frontmatter

Optional YAML frontmatter at the top of `lat.md/` files:

```yaml
---
lat:
  require-code-mention: true
---
```

Currently the only supported field is `require-code-mention` for test spec enforcement.

## Validation

Always run `lat check` after editing `lat.md/` files. It validates:
- All wiki links point to existing sections, repository paths, or source code symbols
- All relative markdown links point to existing files
- Full and collapsed reference-style links have definitions
- All `@lat:` code refs point to existing sections
- Every section has a leading paragraph (≤250 chars)
- All `require-code-mention` leaf sections are referenced in code
- Every `lat.md/` directory has an accurate index
