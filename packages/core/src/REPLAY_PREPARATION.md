# Replay preparation admission

ReplayPayloadCache remains invocation scoped. Its default preparation limits
are eight concurrent jobs, 16 MiB of serialized input in flight and 32 MiB of
successful prepared plaintext resident. Its optional third constructor argument
is an internal tuning seam. It does not change World interfaces or the payload
wire format.

The exact preparation promise is registered before a job starts. A consumer can
promote queued speculation to the demand queue. After three demand admissions,
a waiting speculative job gets an opportunity, subject to byte admission.
One input larger than the byte budget runs exclusively to guarantee progress.

Successful plaintext is held by a byte-weighted LRU. Oversized results bypass
the resident cache. A failed speculative promise retains its original rejection
until an ordered consumer observes it, so speculation does not advance error
visibility. Deserialization continues in each fresh VM and never shares mutable
revived object graphs between replays.

These are logical input and plaintext budgets, not an RSS ceiling. Decrypt and
decompress temporaries, VM objects, the event log and promises are not included.
`prewarm()` also temporarily retains its `Promise.allSettled()` results.
