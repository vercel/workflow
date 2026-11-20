---
'@workflow/world-postgres': patch
---

Fix `invoke()` timing out when several invocations were submitted to one run while a delivery held it: their wakes collapse into one, and the delivery that wake started could end after answering only the first when each took longer than 100 ms to deliver. It now delivers every invocation it found, and leaves a wake for any still in the mailbox when it ends.
