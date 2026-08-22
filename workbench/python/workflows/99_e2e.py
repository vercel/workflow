"""Python ports of the fixtures in `workbench/example/workflows/99_e2e.ts`.

The TypeScript e2e suite (`packages/core/e2e/e2e.test.ts`) is the single source
of truth for cross-language conformance: the driver stays in TypeScript, and the
app side gets reimplemented per language. This file is the Python app side.

Two conventions that look wrong and are not:

- **The module is named `99_e2e.py`**, matching the TS fixture file. That is not
  importable with an `import` statement, so `app.py` loads it with
  `importlib.import_module`. The name has to match because the harness looks
  fixtures up by file path (`workflows/99_e2e.ts`) and matches manifest keys by
  suffix.

- **Functions keep the TS fixtures' camelCase names** instead of being
  snake_cased. This keeps the manifest emitter mechanical — it can publish
  `qualname -> workflow_id` straight from the registry, with no TS-name to
  Python-name table to maintain and let rot. The camelCase names *are* the
  conformance contract.

Ported fixtures are listed in `../e2e-conformance.json`; a fixture missing from
that list is skipped by the suite. Only add a name there once its test passes.
"""

import asyncio
import random
import time

from vercel.workflow import Workflows, sleep, time_ns

# `as_vercel_job=False` because `app.py` wires the queue entrypoints itself: the
# default constructor creates them and discards the HTTP handlers, and calling
# the entrypoints again to recover a reference would register a second
# subscriber on the same topic and consumer group.
app = Workflows(as_vercel_job=False)


##########################################################
# nullByteWorkflow — 99_e2e.ts:291
#
# A NUL byte surviving the step return is a real cross-language signal: it has
# to round-trip the devalue codec and whatever the world writes to disk without
# being treated as a string terminator.


@app.step
async def nullByteStep() -> str:
    return "null byte \0"


@app.workflow
async def nullByteWorkflow() -> str:
    return await nullByteStep()


##########################################################
# addTenWorkflow — 99_e2e.ts:28
#
# The suite starts this one with a positional input array (`[123]`), and the
# step takes two positional parameters. Both directions of the argument
# encoding are in play: a TS-written `[123]` decoded into a Python call, and
# Python's own `add(a, 2)` written back out the way JS writes it.


@app.step
async def add(a: int, b: int) -> int:
    return a + b


@app.workflow
async def addTenWorkflow(input: int) -> int:
    a = await add(input, 2)
    b = await add(a, 3)
    return await add(b, 5)


##########################################################
# promiseAllWorkflow — 99_e2e.ts:44
#
# `asyncio.gather` is Python's `Promise.all`, and the interesting part is the
# same in both: three steps suspend in a single turn, so the orchestrator has to
# create three pending events before the replay yields.


@app.step
async def randomDelay(v: str) -> str:
    await asyncio.sleep(random.random() * 3)
    return v.upper()


@app.workflow
async def promiseAllWorkflow() -> str:
    a, b, c = await asyncio.gather(
        randomDelay("a"),
        randomDelay("b"),
        randomDelay("c"),
    )
    return a + b + c


##########################################################
# sleepingWorkflow — 99_e2e.ts:201
# parallelSleepWorkflow — 99_e2e.ts:209
# sleepInLoopWorkflow — 99_e2e.ts:3045
#
# `sleep` is the one workflow primitive with no step behind it: the orchestrator
# suspends on a `wait_created` event and the world redelivers the run when the
# timer fires. Porting it checks that Python emits a wait the TypeScript driver
# recognises — `cancelRun` waits for exactly that event type before cancelling.
#
# The clock needs care. The tests do arithmetic on the returned timestamps and
# compare against millisecond thresholds, so these return `time_ns() // 1e6`
# rather than `now()`: `vercel.workflow.now()` hands back a `datetime`, which is
# the right Python type and the wrong wire type for `endTime - startTime`.


@app.workflow
async def sleepingWorkflow(durationMs: int = 10_000) -> dict:
    startTime = time_ns() // 1_000_000
    await sleep(durationMs)
    endTime = time_ns() // 1_000_000
    return {"startTime": startTime, "endTime": endTime}


@app.workflow
async def parallelSleepWorkflow() -> dict:
    startTime = time_ns() // 1_000_000
    await asyncio.gather(*(sleep("6s") for _ in range(10)))
    endTime = time_ns() // 1_000_000
    return {"startTime": startTime, "endTime": endTime}


@app.step
async def noopStep(iteration: int) -> dict:
    # Wall clock, not the deterministic workflow clock: this runs in the step
    # context, and the test reads these timestamps to prove the sleeps between
    # iterations were really honoured rather than replayed away.
    return {"iteration": iteration, "ts": time.time_ns() // 1_000_000}


@app.workflow
async def sleepInLoopWorkflow() -> dict:
    iterations = 3
    sleepMs = 3_000
    timestamps = []

    for i in range(iterations):
        result = await noopStep(i)
        timestamps.append(result["ts"])
        if i < iterations - 1:
            await sleep(sleepMs)

    return {"timestamps": timestamps, "totalElapsed": timestamps[-1] - timestamps[0]}
