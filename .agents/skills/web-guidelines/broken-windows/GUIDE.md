# Broken Windows

## When to Use

Use when reading, recording, or resolving guideline violations in `BROKEN-WINDOWS.md` files in `packages/web` or `packages/web-shared`.

## Required Patterns

If you find existing `BROKEN-WINDOWS.md` files, read them so you don't write code that perpetuates the antipatterns they record. When adding new violations, do not remove other existing violations from the file.

Files in ancestor or descendant directories use their own colocated `BROKEN-WINDOWS.md` files. These files are lists. If there are multiple violations or multiple files with violations, list them all, with files in alphabetical order.

When a violation is fixed, remove it from the file. These files must always match the current state of the files they describe.

## Rationale

Co-located records let a future agent find existing violations and the work needed to fix them. Keeping the records aligned with the files prevents fixed violations from staying on the work list and unresolved ones from disappearing.

## Examples

### Violation Record Format

Inside `BROKEN-WINDOWS.md`, each file in the directory that has violations is written out in this format:

```
---
name: file-name.ext
severity: low|medium|high
---

### Summarized Violation Name 1

A detailed description of the first violation and what it would take to fix it. Write it as a prompt for a future agent.

### Summarized Violation Name 2

A detailed description of the second violation and what it would take to fix it. Write it as a prompt for a future agent.

```
