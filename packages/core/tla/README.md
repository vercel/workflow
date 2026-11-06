# TLA+ model: `workflow/state` stored by reference

`StateRefs.tla` models which `workflow/state` records each reader of a run's log
can rebuild (`src/serialization/state-refs.ts`, `src/serialization/state-recovery.ts`).

**Writers** choose a record kind for each version:
- `ref`: the version itself;
- `patch`: its base plus a change;
- `full`: the whole value;
- `plain`: no record, stored as without references.

They choose against the context they hold. Step inputs never register a version.

**Readers:**
- **Replay** reads step outputs and the hook payloads it delivers, in log order.
- **An inline step** shares the replay's context.
- **A cold step** (a queued step, or a retry in a new invocation) rebuilds its context from the run input, every hook payload and every step output. It never reads step inputs and runs no workflow code.

The invariant `NoMissing` says that no reader ever meets a record it can't rebuild.

## Configurations

| Config | World | Expected |
| --- | --- | --- |
| `PR_Node` | Today's Node VM: `produce()` in workflow code has no lineage the serializer sees | holds |
| `PR_WorstCase` | That lineage is visible (any future change that exposes it) | holds |
| `PR_Opaque` | A step can put a value only workflow code can revive (custom-serde class, stream) into state | **violated**: cold steps fail |
| `Fix_Opaque` | Such versions are written `plain` | holds |
| `PR_Undelivered` | The log can hold a `hook_received` that replay doesn't deliver | **violated**: a cold step refers to a source replay never registers |
| `Fix_Undelivered` | Recovery registers only the hook payloads replay delivers | holds |
| `Fix_All` | Every risk on, both fixes on | holds |
| `Cov_*` | Coverage probes: ref inputs, patch outputs, cold steps reading refs, source refs | violated (the model reaches each one) |

## Results

TLC 1.8.0, `MaxVersions = 4`, `MaxSteps = 3`, `MaxHooks = 1`, run exhaustively:

| Config | Result | Distinct states |
| --- | --- | ---: |
| `PR_Node` | holds | 384,371 |
| `PR_WorstCase` | holds | 33,423,363 |
| `PR_Opaque` | violated in 5 states | 1,007 |
| `Fix_Opaque` | holds | 1,484,195 |
| `PR_Undelivered` | violated | 851 |
| `Fix_Undelivered` | holds | 568,272 |
| `Fix_All` | holds | 96,812,454 |
| `Cov_NeverRefInput` / `Cov_NeverPatchOutput` / `Cov_NeverColdRef` / `Cov_NeverSourceRef` | reached | 32 / 304 / 349 / 362 |

`PR_Opaque`'s counterexample is the bug `workbench/vitest/test/state-refs.test.ts` reproduces end to end:
1. Step 1 runs inline and adds an opaque value through a patch.
2. Step 2 runs cold with a `ref` input to the earlier, clean version.
3. Recovery reads every output, so it still fails.

## Status after the frozen-value redesign

The code no longer has a `produce()` of its own: any deeply frozen plain value is tracked, found by the objects it shares with known versions. In the model's terms:
- `PR_WorstCase` (lineage visible) is the normal case now. Workflow-body values are tracked like any frozen value.
- `Fix_Opaque` is what the code does: state holding a custom-serde class or other non-plain value isn't tracked, so it is written `plain`.
- `Undelivered` is fixed differently from `Fix_Undelivered`: a context rebuilt by cold recovery writes no hook-string references (`writesSourceRefs`), so only replay's context, whose sources every reader also registers, refers to them. The model hasn't been rerun for this variant.

## Running

```bash
./check.sh               # every config; exits non-zero on an unexpected result
./check.sh PR_Opaque.cfg # one config
```

It needs Java 11 or later, and downloads `tla2tools.jar` (TLA+ 1.8.0) into `~/.cache` once. Set `TLA2TOOLS_JAR` to use your own.

Most configs take seconds to a few minutes on 4 cores. `PR_WorstCase` takes about 15 minutes and `Fix_All` about 50.

## Out of scope

These are covered by the fuzz test `src/serialization/state-refs.fuzz.test.ts` and by the end-to-end tests instead:
- the snapshot rule, a size heuristic that doesn't affect correctness;
- key order, holes and value types;
- run-ahead speculation;
- which VM decides whether references are written.
