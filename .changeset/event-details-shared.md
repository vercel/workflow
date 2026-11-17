---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Share one event's details between the sidebar's event cards and the Events tab's details panel. The payload loader is now aborted when superseded, so a load that settles late after Decrypt no longer overwrites the decrypted payload, and the sidebar no longer refetches payloads that came complete with the event. Sidebar event IDs are copyable, load errors in the details panel use the error card, and ignored (duplicate or sealed) events are struck through in the sidebar and the panel title as they are in the events table.
