---
"@workflow/core": patch
---
Load the event log once, after `run_started`, on a `start({ experimental_hook })` candidate's first spec 9 delivery, instead of before and after it. Starting each such run makes one fewer World read, and that delivery no longer races `run_created`.
