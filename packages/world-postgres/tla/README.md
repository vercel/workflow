# TLA+ model: stream writes against data deletion

`StreamPurge.tla` models a stream chunk insert (`appendChunks` in
`src/streamer.ts`) racing a run's terminal transition and the deletion of its
data (`purgeRunUserData` in `src/retention.ts`), under Postgres row locks and
statement snapshots.

**Actors:**
- **Writers** read the run's `expired_at`, insert a chunk unless it is set, and commit.
- **Finish** updates the run row to a terminal status.
- **Purge** updates the run row (stamping `expired_at`), blanks the chunks its statement can see, and commits.

The invariant `NoLeak` says that once the purge has committed, no committed
chunk holds bytes, at any moment. `QuiescentNoLeak` is the weaker form: none
once every writer has finished.

## Configurations

| Config | Design | Expected |
| --- | --- | --- |
| `Shipped` | Every insert reads `expired_at` under `FOR SHARE`; the purge updates the run first, at READ COMMITTED | `NoLeak` holds |
| `Var_KeyShare` | `FOR KEY SHARE` instead, which a non-key `UPDATE` does not conflict with | **violated** |
| `Var_RepeatableRead` | The purge runs at REPEATABLE READ, so its chunk clear uses a snapshot taken before it waited | **violated** |
| `Var_RunLast` | The purge clears chunks before it updates the run | **violated** |
| `Main` | Before #5687: only a finished run is locked, and a scrub follows the insert's commit | **violated**: bytes are readable between the commit and the scrub |
| `Main_Quiescent` | The same design against `QuiescentNoLeak` | holds, as long as no writer dies before its scrub |

## Results

TLC 1.8.0, three writers, run exhaustively by `./check.sh`:

| Config | Result | Distinct states |
| --- | --- | ---: |
| `Shipped` | holds | 440 |
| `Main_Quiescent` | holds | 3,508 |
| `Var_KeyShare` / `Var_RepeatableRead` / `Var_RunLast` / `Main` | violated | search stops at the first counterexample |

TLC also reports no deadlock in any configuration.

## What the model leaves out

- **Lock fairness.** A waiting purge or terminal transition is assumed to get the run row eventually. Postgres admits a new shared locker ahead of a waiting updater, so inserts that overlap without a gap can keep it waiting.
- **Other run-row writers** (hook resumes, `wake_pending`), which take the same lock as Finish.
- **The read gate.** Reads return no bytes for a run with `expired_at` set, whatever the chunk holds.

`test/stream-deletion-race.test.ts` races the same actors against a real
database.
