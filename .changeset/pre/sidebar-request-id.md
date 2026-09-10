---
'@workflow/web-shared': minor
---

Surface an analytics event's `vercelId` in the run sidebar's Metadata list as a copyable "Request ID", and stop rendering the literal text `null` for a provenance id the analytics contract left empty. Also order Metadata rows missing from the panel's explicit order list after the listed ones instead of ahead of them, so a failed step's Error Code no longer renders above the step's own name.
