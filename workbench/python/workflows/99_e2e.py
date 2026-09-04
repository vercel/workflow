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
import dataclasses
import json
import random
import re
import time
from typing import Any, Awaitable, TypeVar

import pydantic

from vercel.workflow import (
    BaseHook,
    FatalError,
    RetryableError,
    Run,
    WorkflowWritable,
    Workflows,
    get_step_metadata,
    get_writable,
    set_attributes,
    sleep,
    start,
    time_ns,
)
from vercel.workflow._internal.core import Step

app = Workflows()


##########################################################
# nullByteWorkflow
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
# addTenWorkflow
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
# payloadCompressionWorkflow
#
# A compressible value crosses all three payloads Python writes during an
# ordinary workflow: the step input, the step result, and the run output. The
# shared driver checks both the hydrated value and the raw event prefixes.


@app.step
async def roundTripCompressiblePayload(payload: str) -> str:
    return payload


@app.workflow
async def payloadCompressionWorkflow(payload: str) -> str:
    return await roundTripCompressiblePayload(payload)


##########################################################
# promiseAllWorkflow
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
# sleepingWorkflow
# parallelSleepWorkflow
# sleepInLoopWorkflow
#
# `sleep` is the one workflow primitive with no step behind it: the orchestrator
# suspends on a `wait_created` event and the world redelivers the run when the
# timer fires. Porting it checks that Python emits a wait the TypeScript driver
# recognises — `cancelRun` waits for exactly that event type before cancelling.
# TypeScript fixture inputs are milliseconds; numeric Python durations are seconds.
#
# The clock needs care. The tests do arithmetic on the returned timestamps and
# compare against millisecond thresholds, so these return `time_ns() // 1e6`
# rather than `now()`: `vercel.workflow.now()` hands back a `datetime`, which is
# the right Python type and the wrong wire type for `endTime - startTime`.


@app.workflow
async def sleepingWorkflow(durationMs: int = 10_000) -> dict:
    startTime = time_ns() // 1_000_000
    await sleep(durationMs / 1_000)
    endTime = time_ns() // 1_000_000
    return {"startTime": startTime, "endTime": endTime}


@app.workflow
async def parallelSleepWorkflow() -> dict:
    startTime = time_ns() // 1_000_000
    await asyncio.gather(*(sleep("1s") for _ in range(10)))
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
            await sleep(sleepMs / 1_000)

    return {"timestamps": timestamps, "totalElapsed": timestamps[-1] - timestamps[0]}


##########################################################
# Racing suspensions
#
# `Promise.race` and `Promise.any` have no asyncio spelling that takes bare
# awaitables, so the five race fixtures below share these two helpers. Both
# resolve ties by the order the awaitables were passed rather than by set
# iteration order — `asyncio.wait` returns a `set`, and a workflow body has to
# be deterministic across replays, so picking `next(iter(done))` would be a
# latent replay divergence the moment two steps land in the same turn.
#
# Nothing cancels the losers, matching JS: a race that resolves leaves the
# other steps running, the body returns, and `_run_in_loop` cancels the
# orphaned tasks on its way out. Their step invocations are already in flight
# and complete against a run that has finished, exactly as they do on the
# TypeScript side.

_T = TypeVar("_T")


async def _race(*awaitables: Awaitable[_T]) -> _T:
    """`Promise.race`: settle with the first to settle, error included."""
    tasks = [asyncio.ensure_future(a) for a in awaitables]
    done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in tasks:
        if task in done:
            return task.result()
    raise AssertionError("asyncio.wait returned no completed task")


async def _any(*awaitables: Awaitable[_T]) -> _T:
    """`Promise.any`: the first to *succeed*; failures are skipped."""
    tasks = [asyncio.ensure_future(a) for a in awaitables]
    pending = set(tasks)
    while pending:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for task in tasks:
            if task in done and task.exception() is None:
                return task.result()
    raise RuntimeError("all awaitables rejected")


##########################################################
# promiseRaceWorkflow
# promiseAnyWorkflow
#
# The counterpart to `promiseAllWorkflow`: three steps suspend in one turn, but
# the body resumes on the first one instead of all three. That is the case
# where replay and completion overlap — the run finishes while two step
# invocations are still outstanding.
#
# `promiseAnyWorkflow` additionally needs a step failure to be *skippable*
# rather than fatal. Python surfaces a failed step to the body as a
# `RuntimeError` carrying the step's error text (see the note on
# `errorRetryDisabled` below), which is all `_any` needs — it only asks whether
# the task raised.


@app.step
async def specificDelay(delay: int, v: str) -> str:
    await asyncio.sleep(delay / 1000)
    return v.upper()


@app.workflow
async def promiseRaceWorkflow() -> str:
    return await _race(
        specificDelay(10_000, "a"),
        specificDelay(100, "b"),  # "b" should always win
        specificDelay(20_000, "c"),
    )


@app.step
async def stepThatFails() -> str:
    raise FatalError("step failed")


@app.workflow
async def promiseAnyWorkflow() -> str:
    return await _any(
        stepThatFails(),
        specificDelay(100, "b"),  # "b" should always win
        specificDelay(6_000, "c"),
    )


##########################################################
# sleepWinsRaceWorkflow
# stepWinsRaceWorkflow
#
# A race between the two suspension kinds. `sleep` resumes from a timer the
# world owns and a step resumes from an event the step handler writes, so these
# assert that the orchestrator resolves whichever lands first without waiting
# for the other — the driver bounds `durationMs` at 5s against a 10s loser.


@app.step
async def delayMsStep(ms: int, label: str) -> str:
    await asyncio.sleep(ms / 1000)
    return label


async def _sleepThen(duration: str, label: str) -> str:
    """`sleep(...).then(() => label)` — a plain coroutine, not a step."""
    await sleep(duration)
    return label


@app.workflow
async def sleepWinsRaceWorkflow() -> dict:
    startTime = time_ns() // 1_000_000
    winner = await _race(delayMsStep(10_000, "step"), _sleepThen("1s", "sleep"))
    endTime = time_ns() // 1_000_000
    return {"winner": winner, "durationMs": endTime - startTime}


@app.workflow
async def stepWinsRaceWorkflow() -> dict:
    startTime = time_ns() // 1_000_000
    winner = await _race(delayMsStep(1_000, "step"), _sleepThen("10s", "sleep"))
    endTime = time_ns() // 1_000_000
    return {"winner": winner, "durationMs": endTime - startTime}


##########################################################
# promiseRaceStressTestWorkflow
#
# Five steps 5s apart, raced and retired one at a time, so the body re-enters
# `_race` over a shrinking set across five separate replays. Each replay has to
# rebuild the same suspensions in the same order and match them to the events
# already in the log; a single misaligned slot shows up as a missing or
# duplicated entry in the returned list.


@app.step
async def promiseRaceStressTestDelayStep(dur: int, resp: int) -> int:
    await asyncio.sleep(dur / 1000)
    return resp


@app.workflow
async def promiseRaceStressTestWorkflow() -> list:
    # Tasks rather than coroutines: unlike a JS promise, a coroutine can only
    # be awaited once, and every loop iteration races the survivors again.
    promises = {
        i: asyncio.ensure_future(promiseRaceStressTestDelayStep(1000 * 5 * i, i))
        for i in range(5)
    }
    done = []

    while promises:
        res = await _race(*promises.values())
        done.append(res)
        del promises[res]

    return done


##########################################################
# errorRetrySuccess
# errorRetryDisabled
#
# The two halves of the step retry policy: the default (`DEFAULT_MAX_RETRIES`,
# 3 in both SDKs) and `max_retries=0`. `get_step_metadata().attempt` is what
# makes them observable from inside the step, and it is the same 1-based
# counter the driver reads back off the step entity through the CLI.
#
# These two work because neither inspects the exception. `errorRetryDisabled`
# reads its attempt number back out of the message *text*, which is the one part
# of a thrown error that survives the event log — see the note on
# `errorFatalCatchable` below for what does not.


@app.step
async def retryUntilAttempt3() -> int:
    attempt = get_step_metadata().attempt
    if attempt < 3:
        raise RuntimeError(f"Failed on attempt {attempt}")
    return attempt


@app.workflow
async def errorRetrySuccess() -> dict:
    return {"finalAttempt": await retryUntilAttempt3()}


@app.step(max_retries=0)
async def throwWithNoRetries() -> None:
    raise RuntimeError(f"Failed on attempt {get_step_metadata().attempt}")


@app.workflow
async def errorRetryDisabled() -> dict:
    try:
        await throwWithNoRetries()
        return {"failed": False, "attempt": None}
    except Exception as e:
        match = re.search(r"attempt (\d+)", str(e))
        return {"failed": True, "attempt": int(match.group(1)) if match else None}


##########################################################
# outputStreamWorkflow
# outputStreamInsideStepWorkflow
# utf8StreamWorkflow
#
# Run-scoped streams, which are the one part of the protocol that does not
# travel through the event log: chunks are appended to a separate per-run log
# that a reader tails live. The driver reads them with `run.getReadable()`, so
# these fixtures assert that Python's framing and payload encoding are the ones
# `@workflow/core`'s `getDeserializeStream` expects.
#
# Both spellings of the same API are covered, because they take different paths
# through the SDK. `get_writable()` in the *workflow body* returns a
# `WorkflowStreamHandle` — the body replays and has no network, so it cannot
# write — and passing that handle into a step's arguments is what turns it into
# a writer, via the serialization layer. `get_writable()` in a *step* returns
# the writer directly. The two have to name the same stream for the workflow to
# be able to hand one to a step at all.
#
# A `bytes` chunk arrives on the TypeScript side as a `Uint8Array` and anything
# else as its devalue value, which is why the driver reads chunk 0 as binary
# and chunk 1 as an object.
#
# Nothing closes a stream implicitly in either SDK, and the driver asserts the
# reader sees `done` — hence the explicit `stepCloseOutputStream` at the end of
# each fixture.


@app.step
async def stepWithOutputStreamBinary(writable: WorkflowWritable, text: str) -> None:
    await writable.write(text.encode())


@app.step
async def stepWithOutputStreamObject(writable: WorkflowWritable, obj: Any) -> None:
    await writable.write(obj)


@app.step
async def stepCloseOutputStream(writable: WorkflowWritable) -> None:
    await writable.close()


@app.workflow
async def outputStreamWorkflow() -> str:
    writable = get_writable()
    namedWritable = get_writable(namespace="test")
    await sleep("1s")
    await stepWithOutputStreamBinary(writable, "Hello, world!")
    await sleep("1s")
    await stepWithOutputStreamBinary(namedWritable, "Hello, named stream!")
    await sleep("1s")
    await stepWithOutputStreamObject(writable, {"foo": "test"})
    await sleep("1s")
    await stepWithOutputStreamObject(namedWritable, {"foo": "bar"})
    await sleep("1s")
    await stepCloseOutputStream(writable)
    await stepCloseOutputStream(namedWritable)
    return "done"


@app.step
async def stepWithOutputStreamInsideStep(text: str) -> None:
    await get_writable().write(text.encode())


@app.step
async def stepWithNamedOutputStreamInsideStep(namespace: str, obj: Any) -> None:
    await get_writable(namespace=namespace).write(obj)


@app.step
async def stepCloseOutputStreamInsideStep(namespace: str | None = None) -> None:
    await get_writable(namespace=namespace).close()


@app.workflow
async def outputStreamInsideStepWorkflow() -> str:
    await sleep("1s")
    await stepWithOutputStreamInsideStep("Hello from step!")
    await sleep("1s")
    await stepWithNamedOutputStreamInsideStep(
        "step-ns", {"message": "Hello from named stream in step!"}
    )
    await sleep("1s")
    await stepWithOutputStreamInsideStep("Second message")
    await sleep("1s")
    await stepWithNamedOutputStreamInsideStep("step-ns", {"counter": 42})
    await sleep("1s")
    await stepCloseOutputStreamInsideStep()
    await stepCloseOutputStreamInsideStep("step-ns")
    return "done"


@app.step
async def stepWriteUtf8Text(writable: WorkflowWritable, text: str) -> None:
    await writable.write(text.encode())


@app.step
async def stepWriteUtf8Json(writable: WorkflowWritable, value: Any) -> None:
    await writable.write(json.dumps(value, ensure_ascii=False).encode())


@app.workflow
async def utf8StreamWorkflow() -> str:
    writable = get_writable()
    await sleep("1s")
    await stepWriteUtf8Text(writable, "Hello, world!")
    await stepWriteUtf8Text(writable, "Café — naïve résumé")
    await stepWriteUtf8Text(writable, "你好，世界！🌍✨")
    await stepWriteUtf8Text(writable, "مرحبا بالعالم")
    await stepWriteUtf8Json(writable, {"greeting": "안녕하세요", "emoji": "🎉"})
    await stepCloseOutputStream(writable)
    return "done"


##########################################################
# errorRetryFatal
# errorFatalCatchable
# errorStepThrowFatalRoundTrip
# errorWorkflowThrowFatalRoundTrip
#
# `FatalError` is a retry-control error the step handler honours: `fatal or
# attempt >= max_retries + 1` is what decides whether to write `step_failed`
# instead of `step_retrying`, so a step that raises it burns exactly one attempt.
#
# All four turn on the error surviving the event log, which vercel-py now does
# the way upstream does — the thrown value goes through the serialization
# pipeline onto `step_failed` / `run_failed`, on the same devalue tags
# `@workflow/core` uses. So the `except` below catches the `FatalError` the step
# raised, `__cause__` is the `TypeError` it was raised from, and the run carries
# `errorCode: USER_ERROR` rather than the name of whichever class reached the
# handler.
#
# Two notes on the Python spelling of the round-trip fixture. `isFatal` and
# `isInstanceOf` are one check here: TypeScript distinguishes `FatalError.is()`
# (a name check, for errors from another realm) from `instanceof`, and Python's
# sandbox shares the host's class object so there is nothing to distinguish. And
# the cause is attached with `raise ... from ...`, which is `__cause__` — the
# explicit attribution JavaScript's `cause` also means.


@app.step
async def throwFatalError() -> None:
    raise FatalError("Fatal step error")


@app.workflow
async def errorRetryFatal() -> str:
    await throwFatalError()
    return "never reached"


@app.workflow
async def errorFatalCatchable() -> dict:
    try:
        await throwFatalError()
        return {"caught": False, "isFatal": False}
    except Exception as e:
        return {"caught": True, "isFatal": isinstance(e, FatalError)}


@app.step
async def throwFatalErrorWithCause() -> None:
    raise FatalError("fatal with cause") from TypeError("underlying type error")


@app.workflow
async def errorStepThrowFatalRoundTrip() -> dict:
    try:
        await throwFatalErrorWithCause()
        return {"caught": False}
    except Exception as e:
        cause = e.__cause__
        return {
            "caught": True,
            "isFatal": isinstance(e, FatalError),
            "isInstanceOf": isinstance(e, FatalError),
            "message": str(e),
            "name": type(e).__name__,
            "hasFatalProp": getattr(e, "fatal", None) is True,
            "causeIsTypeError": isinstance(cause, TypeError),
            "causeName": type(cause).__name__ if cause is not None else None,
            "causeMessage": str(cause) if cause is not None else None,
        }


@app.workflow
async def errorWorkflowThrowFatalRoundTrip() -> str:
    # `ValueError` where the TypeScript fixture throws a `RangeError`: they are
    # the pair on the wire, so a JavaScript reader of this run's `run_failed`
    # gets a real `RangeError` back out of the cause.
    raise FatalError("workflow exploded") from ValueError("out of bounds")


##########################################################
# metadataFromHelperWorkflow
#
# Upstream's #1577 regression test: the metadata accessors have to work from a
# helper defined at module level rather than inline in the step body. The
# mechanism differs — `AsyncLocalStorage` there, a `contextvars.ContextVar`
# here — but the failure mode it guards against is the same one, a context
# that only propagates as far as the decorated function.
#
# Only the step half is checked. `getStepMetadata()`'s counterpart
# `getWorkflowMetadata()` has no Python equivalent, so `workflowRunId` comes
# off `StepInfo.run_id`, which is the same run id the TypeScript fixture reads
# out of the workflow metadata. That also makes `workflowAndStepMetadataWorkflow`
# — which asserts the two metadata objects against each other — unportable for
# now, so it is not in this file.


async def _withStrictMetadataCheck(fn):
    stepMetadata = get_step_metadata()
    return await fn(), stepMetadata


@app.step
async def metadataHelperStep(label: str) -> dict:
    async def _produce() -> str:
        return label

    _result, stepMetadata = await _withStrictMetadataCheck(_produce)

    return {
        "label": label,
        "workflowRunId": stepMetadata.run_id,
        "stepId": stepMetadata.step_id,
        "attempt": stepMetadata.attempt,
    }


@app.workflow
async def metadataFromHelperWorkflow(label: str) -> dict:
    return await metadataHelperStep(label)


##########################################################
# spawnWorkflowFromStepWorkflow
#
# A run that starts another run. `start()` is a world write, so it can only
# happen in a step — the workflow body replays and its sandbox has no network,
# which is the same restriction the TypeScript fixture states in a comment.
# Waiting for the child is a step for the same reason.
#
# `Run(run_id).return_value()` polls the child's status; the TypeScript
# `getRun(runId).returnValue` is the same shape. Both hold the parent's step
# open for as long as the child takes, which is the caveat the TS fixture's
# `fibonacciWorkflow` neighbour documents at length — worth remembering before
# porting that one, since its recursion needs the worker pool to be deep enough
# for every waiting parent.


@app.step
async def doubleValue(value: int) -> int:
    return value * 2


@app.workflow
async def childWorkflow(value: int) -> dict:
    return {"childResult": await doubleValue(value), "originalValue": value}


@app.step
async def spawnChildWorkflow(value: int) -> str:
    childRun = await start(childWorkflow, value)
    return childRun.run_id


@app.step
async def awaitWorkflowResult(runId: str) -> Any:
    return await Run(runId).return_value()


@app.workflow
async def spawnWorkflowFromStepWorkflow(inputValue: int) -> dict:
    childRunId = await spawnChildWorkflow(inputValue)
    childResult = await awaitWorkflowResult(childRunId)
    return {
        "parentInput": inputValue,
        "childRunId": childRunId,
        "childResult": childResult,
    }


##########################################################
# stepNotRegisteredCatchable
# stepNotRegisteredUncaught
#
# These fixtures deliberately construct Step wrappers without registering them
# with `app`. TypeScript reaches the same otherwise-impossible deployment shape
# through its internal WORKFLOW_USE_STEP symbol. The private constructor is
# confined to this conformance fixture; application code should use `@app.step`.


async def nonExistentStep() -> None:
    raise AssertionError("an unregistered step body must never execute")


async def anotherNonExistentStep() -> None:
    raise AssertionError("an unregistered step body must never execute")


_nonExistentStep = Step(nonExistentStep)
_anotherNonExistentStep = Step(anotherNonExistentStep)


@app.workflow
async def stepNotRegisteredCatchable() -> dict:
    try:
        await _nonExistentStep()
        return {"caught": False, "error": None}
    except Exception as error:
        return {"caught": True, "error": str(error)}


@app.workflow
async def stepNotRegisteredUncaught() -> None:
    await _anotherNonExistentStep()


##########################################################
# hookWithSleepWorkflow
# hookWithSleepFinalStepWorkflow
# hookTokenReuseLoopWorkflow
# sleepWithSequentialStepsWorkflow
#
# `HookEvent` implements both `__await__` (one payload) and `__aiter__` /
# `__anext__` (a stream of them), so `for await (const p of hook)` ports to
# `async for payload in hook` directly. `Hook.set_result` requires the
# class handed to `wait()` to be a dataclass or a pydantic model, and calls
# `hook_cls(**raw)` on the plain JSON the resumer sent — so the port is a
# dataclass with a default per optional field, and the fixture's structural
# type becomes a declared one. The declaration has to stay loose in the same
# places the TypeScript type is optional: the driver resumes with `{type, id}`
# on one payload and `{type, done}` on another, and a required field would
# raise on whichever call omitted it.
#
# Three translation details matter here:
#
# - **`using hook` is not `try/finally`.** A Python workflow body unwinds
#   through a `_SuspendException` on *every* suspension, so a `finally` around
#   an `await` runs once per turn rather than once at scope exit. Disposing a
#   hook there deletes the suspension before the orchestrator can flush its
#   `hook_created`, and the run stalls with no hook for the driver to resume.
#   Dispose on the normal path only.
# - **`void sleep('1d')`** is `asyncio.ensure_future(sleep("1d"))`. The wait is
#   created and never completes; the body returns first and the orphaned task
#   is cancelled with the loop.
# - **A step takes the payload as a dict**, not as the dataclass: keeping the
#   step signature `dict` avoids registering a serializer for a type that only
#   exists to satisfy `set_result`.
#
# `sleepWithSequentialStepsWorkflow` is the cluster's control and has no hook in
# it at all — a fire-and-forget sleep plus three sequential steps.


@dataclasses.dataclass
class SleepHookPayload(BaseHook):
    type: str
    id: int | None = None
    done: bool | None = None


@app.step
async def processPayload(payload: dict) -> dict:
    return {"processed": True, "type": payload["type"], "id": payload.get("id")}


@app.workflow
async def hookWithSleepWorkflow(token: str) -> list:
    hook = SleepHookPayload.wait(token=token)

    # Concurrent sleep that won't complete during the test
    asyncio.ensure_future(sleep("1d"))

    results = []
    async for payload in hook:
        results.append(await processPayload(dataclasses.asdict(payload)))
        if payload.done:
            break

    hook.dispose()
    return results


@app.workflow
async def hookWithSleepFinalStepWorkflow(token: str) -> dict:
    hook = SleepHookPayload.wait(token=token)
    asyncio.ensure_future(sleep("1d"))

    seen = []
    finalResult = None
    async for payload in hook:
        if payload.id is not None:
            seen.append(payload.id)
        if payload.done:
            finalResult = await processPayload(dataclasses.asdict(payload))
            break

    hook.dispose()
    return {"seen": seen, "finalResult": finalResult}


@dataclasses.dataclass
class ReuseHookPayload(BaseHook):
    message: str


@app.workflow
async def hookTokenReuseLoopWorkflow(token: str, rounds: int) -> dict:
    received = []
    for round_index in range(rounds):
        hook = ReuseHookPayload.wait(token=token)

        conflict = await hook.get_conflict()
        if conflict is not None:
            return {"received": received, "conflictRound": round_index}

        payload = await hook
        received.append(payload.message)
        hook.dispose()

    return {"received": received, "conflictRound": None}


@app.step
async def addNumbers(a: int, b: int) -> int:
    return a + b


@app.workflow
async def sleepWithSequentialStepsWorkflow() -> dict:
    shouldCancel = False

    async def _cancelAfterSleep() -> None:
        nonlocal shouldCancel
        await sleep("1d")
        shouldCancel = True

    asyncio.ensure_future(_cancelAfterSleep())

    a = await addNumbers(1, 2)
    b = await addNumbers(a, 3)
    c = await addNumbers(b, 4)
    return {"a": a, "b": b, "c": c, "shouldCancel": shouldCancel}


##########################################################
# Cancellable steps
#
# These fixtures cover cancellation behavior that is shared across runtimes:
# timeout, parallel cancellation, reason propagation, and hook-triggered
# cancellation. JavaScript implements them with AbortSignal; Python opts a step
# in with `cancellable=True` and cancels the asyncio task awaiting it. The APIs
# differ, but the driver asserts only the shared behavior.


@app.step(cancellable=True)
async def cancellableLongStep() -> dict:
    try:
        await asyncio.sleep(30)
    except asyncio.CancelledError as error:
        return {
            "result": "aborted",
            "reason": str(error.args[0]) if error.args else None,
        }
    return {"result": "completed", "reason": None}


async def _cancelAndWait(task: asyncio.Task, reason: str | None = None) -> dict:
    task.cancel(reason)
    return await task


@app.workflow
async def abortTimeoutWorkflow() -> dict:
    longStep = asyncio.ensure_future(cancellableLongStep())
    winner = await _race(longStep, sleep("3s"))
    if winner is None:
        state = await _cancelAndWait(longStep)
        return {"status": "timed out", "aborted": state["result"] == "aborted"}
    return {"status": "completed", "result": winner["result"]}


@app.workflow
async def abortParallelWorkflow() -> dict:
    steps = [asyncio.ensure_future(cancellableLongStep()) for _ in range(3)]
    timeout = asyncio.ensure_future(sleep("3s"))
    done, _pending = await asyncio.wait(
        [*steps, timeout], return_when=asyncio.FIRST_COMPLETED
    )
    if timeout in done:
        results = await asyncio.gather(*(_cancelAndWait(step) for step in steps))
        return {
            "status": "timed out",
            "results": [result["result"] for result in results],
        }
    results = await asyncio.gather(*steps)
    return {
        "status": "completed",
        "results": [result["result"] for result in results],
    }


@app.workflow
async def abortReasonWorkflow() -> dict:
    longStep = asyncio.ensure_future(cancellableLongStep())
    winner = await _race(longStep, sleep("2s"))
    if winner is None:
        state = await _cancelAndWait(longStep, "custom timeout reason")
    else:
        state = winner
    return {
        "aborted": state["result"] == "aborted",
        "reason": state["reason"],
    }


@dataclasses.dataclass
class CancellationHookPayload(BaseHook):
    reason: str


@app.workflow
async def abortViaHookWorkflow(hookToken: str) -> dict:
    hook = CancellationHookPayload.wait(token=hookToken)
    longStep = asyncio.ensure_future(cancellableLongStep())
    winner = await _race(longStep, hook)

    if isinstance(winner, CancellationHookPayload):
        state = await _cancelAndWait(longStep, winner.reason)
        hook.dispose()
        if state["result"] == "aborted":
            return {"status": "cancelled", "reason": state["reason"]}
        return {"status": "completed", "result": state["result"]}

    hook.dispose()
    return {"status": "completed", "result": winner["result"]}


##########################################################
# writableForwardedFromWorkflowWorkflow
# writableForwardedFromStepWorkflow
#
# A stream reference crossing a *run* boundary: the parent hands its writable to
# a child run as part of that run's input, and the driver then reads the bytes
# off the **parent's** stream. So the handle has to survive `start()`'s input
# serialization, arrive in another run's body, and still name the stream it came
# from rather than the child's own — which is why `WorkflowStreamHandle` carries
# a run id instead of deriving one from the ambient run.
#
# The two variants differ in where the parent's `get_writable()` is called, and
# they are not the same path through the SDK. Variant 1 calls it in the workflow
# body, so a *handle* is serialized into a step's arguments, revived there as a
# writer, and serialized again into the child's input. Variant 2 calls it inside
# the step that also calls `start()`, so what gets forwarded is the step-context
# writer directly. Both have to land on the same stream.
#
# `start()` lives in a step for the usual reason: it is a world write, and the
# workflow body replays with no network. The TypeScript fixture says the same
# thing in a comment, which is a good sign the restriction is protocol-shaped
# rather than Python-shaped.


@app.step
async def writeBytesToWritable(writable: WorkflowWritable, payload: str) -> None:
    await writable.write(payload.encode())


@app.workflow
async def writableForwardedChildWorkflow(
    parentWritable: WorkflowWritable, payload: str
) -> str:
    await writeBytesToWritable(parentWritable, payload)
    return "child-done"


@app.step
async def startChildWithWorkflowWritable(
    parentWritable: WorkflowWritable, payload: str
) -> str:
    childRun = await start(writableForwardedChildWorkflow, parentWritable, payload)
    # Let the child finish writing before the parent is allowed to close.
    await childRun.return_value()
    return childRun.run_id


@app.workflow
async def writableForwardedFromWorkflowWorkflow(payload: str) -> dict:
    writable = get_writable()
    childRunId = await startChildWithWorkflowWritable(writable, payload)
    await stepCloseOutputStream(writable)
    return {"childRunId": childRunId}


@app.step
async def startChildWithStepWritable(payload: str) -> str:
    writable = get_writable()
    childRun = await start(writableForwardedChildWorkflow, writable, payload)
    await childRun.return_value()
    await writable.close()
    return childRun.run_id


@app.workflow
async def writableForwardedFromStepWorkflow(payload: str) -> dict:
    return {"childRunId": await startChildWithStepWritable(payload)}


##########################################################
# retainedInterleavingWorkflow
#
# Every suspension kind this app can produce, in one body, with the exact
# composite result asserted — so a dropped, duplicated or misordered boundary
# fails loudly rather than shifting a number nobody checks.
#
# Upstream wrote it for VM retention (`WORKFLOW_RETAINED_VM`): primitive step
# arguments keep the retained VM, a non-primitive argument demotes the boundary
# to a cold replay. Python has no such VM, so `unwrapValue`'s object argument is
# just an object argument here. That does not make the fixture pointless on this
# side — what the test actually asserts is that nine values come back right
# across a step / gather / race / sleep / hook interleaving, and that is the
# same claim in any language.
#
# The hook is created with a token and no metadata, and it is awaited
# *concurrently with a step* —
# `asyncio.gather(hook, add(...))`, since `HookEvent` is awaitable. Dispose on
# the normal path only; see the hook cluster above for why `finally` would break
# it.


@app.step
async def unwrapValue(box: dict) -> int:
    return box["value"]


@dataclasses.dataclass
class DeltaPayload(BaseHook):
    delta: int


@app.workflow
async def retainedInterleavingWorkflow(token: str) -> dict:
    a = await add(1, 2)
    b = await unwrapValue({"value": a})
    c, d = await asyncio.gather(add(b, 10), add(b, 20))
    e, f = await asyncio.gather(unwrapValue({"value": c}), add(d, 1))
    winner = await _race(delayMsStep(100, "step"), _sleepThen("30s", "sleep"))
    await sleep("1s")

    hook = DeltaPayload.wait(token=token)
    payload, g = await asyncio.gather(hook, add(e + f, 100))
    h = await add(g, payload.delta)
    hook.dispose()

    return {
        "a": a,
        "b": b,
        "c": c,
        "d": d,
        "e": e,
        "f": f,
        "winner": winner,
        "g": g,
        "h": h,
    }


##########################################################
# hookWorkflow
# hookCleanupTestWorkflow
# hookDisposeTestWorkflow
#
# The three fixtures that needed hook *metadata* and nothing else. Metadata is
# how a run tells its resumer what it is waiting for: attached once when the hook
# is registered, read back off the hook entity rather than out of a payload. The
# suite leans on it hard — `hookWorkflow`'s driver resumes with
# `customData: hook.metadata?.customData` and then asserts the workflow saw that
# exact value, so a missing metadata field does not weaken the test, it fails it.
#
# `hookWorkflow`'s payload is a **pydantic model** rather than a dataclass, and
# that is load-bearing rather than a style choice. The driver sends `done` only
# on the last payload, and the test asserts the first two come back with `done`
# *absent* — `undefined`, not `false` and not `null`. A dataclass materializes
# every optional field, so `dataclasses.asdict` would report `done: None` and the
# assertion would fail on the difference between "not sent" and "sent as null".
# `model_dump(exclude_unset=True)` reproduces what the resumer actually sent,
# which is the property the test is really about. The other two fixtures have no
# optional fields and stay dataclasses.
#
# `using hook` becomes an explicit `dispose()` on the normal path — never a
# `finally`; see the hook cluster above for why. Where that dispose lands matters
# only in `hookDisposeTestWorkflow`, and there it is the whole point: it releases
# the token *before* the 5s sleep, so another run can claim it while this one is
# still going. In the other two the run completes right after, which frees the
# token anyway, so the call is a formality kept for symmetry with the fixture.


class HookPayload(BaseHook, pydantic.BaseModel):
    message: str
    customData: str
    done: bool | None = None


@app.workflow
async def hookWorkflow(token: str, customData: str) -> list:
    hook = HookPayload.wait(token=token, metadata={"customData": customData})

    payloads = []
    async for payload in hook:
        payloads.append(payload.model_dump(exclude_unset=True))
        if payload.done:
            break

    hook.dispose()
    return payloads


@dataclasses.dataclass
class MessagePayload(BaseHook):
    message: str
    customData: str


@app.workflow
async def hookCleanupTestWorkflow(token: str, customData: str) -> dict:
    hook = MessagePayload.wait(token=token, metadata={"customData": customData})
    payload = await hook
    hook.dispose()
    return {
        "message": payload.message,
        "customData": payload.customData,
        "hookCleanupTestData": "workflow_completed",
    }


##########################################################
# hookGetConflict* and run-idempotency fixtures
#
# `get_conflict()` is a distinct suspension from awaiting a hook payload: it
# commits the hook registration, then resumes with either `None` or a `Run` for
# the current owner. Python's Run methods perform world I/O directly rather than
# becoming durable step proxies, so owner status/result lookups live in steps —
# the same split `spawnWorkflowFromStepWorkflow` uses above.


@dataclasses.dataclass
class ConflictPayload(BaseHook):
    pass


@dataclasses.dataclass
class AdoptPayload(BaseHook):
    value: str


@dataclasses.dataclass
class SignalPayload(BaseHook):
    message: str


@app.step
async def hookGetConflictStep(customData: str) -> dict:
    return {
        "customData": customData,
        "hookGetConflictStepData": "step_completed",
    }


@app.step
async def hookGetConflictTimedStep(label: str, delayMs: int) -> dict:
    startedAt = int(get_step_metadata().step_started_at.timestamp() * 1000)
    await asyncio.sleep(delayMs / 1000)
    return {
        "label": label,
        "startedAt": startedAt,
        "endedAt": time.time_ns() // 1_000_000,
    }


@app.step
async def getRunStatus(runId: str) -> str:
    return await Run(runId).status()


@app.workflow
async def hookGetConflictWorkflow(token: str, customData: str) -> dict:
    hook = ConflictPayload.wait(token=token, metadata={"customData": customData})
    conflict = await hook.get_conflict()

    if conflict is not None:
        return {
            "token": token,
            "customData": customData,
            "conflictRunId": conflict.run_id,
            "conflictStatus": await getRunStatus(conflict.run_id),
            "hookGetConflictTestData": "hook_token_conflict_detected",
        }

    return {
        "token": token,
        "customData": customData,
        "conflictRunId": None,
        "hookGetConflictTestData": "hook_registered_without_payload",
    }


@app.workflow
async def hookGetConflictWithPriorStepWorkflow(token: str, customData: str) -> dict:
    hook = ConflictPayload.wait(token=token, metadata={"customData": customData})
    stepTask = asyncio.ensure_future(hookGetConflictStep(customData))
    conflict = await hook.get_conflict()
    return {
        "token": token,
        "customData": customData,
        "conflictRunId": None if conflict is None else conflict.run_id,
        "stepResult": await stepTask,
        "hookGetConflictTestData": "prior_step_completed_after_registration",
    }


@app.workflow
async def hookGetConflictWithParallelStepWorkflow(token: str, customData: str) -> dict:
    hook = ConflictPayload.wait(token=token, metadata={"customData": customData})
    stepResult, conflict = await asyncio.gather(
        hookGetConflictStep(customData), hook.get_conflict()
    )
    return {
        "token": token,
        "customData": customData,
        "conflictRunId": None if conflict is None else conflict.run_id,
        "stepResult": stepResult,
        "hookGetConflictTestData": "parallel_step_completed_with_registration",
    }


@app.workflow
async def hookGetConflictThenStepParallelWorkflow(token: str, customData: str) -> dict:
    hook = ConflictPayload.wait(token=token, metadata={"customData": customData})

    async def runStepB() -> dict:
        await hook.get_conflict()
        return await hookGetConflictTimedStep("B", 100)

    stepBTask = asyncio.ensure_future(runStepB())
    stepAResult = await hookGetConflictTimedStep("A", 10_000)
    stepBResult = await stepBTask
    return {
        "token": token,
        "customData": customData,
        "stepAResult": stepAResult,
        "stepBResult": stepBResult,
        "hookGetConflictTestData": "registration_then_step_runs_in_parallel",
    }


@app.workflow
async def hookClaimOnlyMutexWorkflow(token: str, holdMs: int) -> dict:
    hook = ConflictPayload.wait(token=token)
    conflict = await hook.get_conflict()
    if conflict is not None:
        return {"role": "duplicate", "conflictRunId": conflict.run_id}

    work = await hookGetConflictTimedStep("A", holdMs)
    return {"role": "owner", "workEndedAt": work["endedAt"]}


@app.workflow
async def hookAdoptOwnerResultWorkflow(token: str, marker: str) -> dict:
    hook = AdoptPayload.wait(token=token)
    conflict = await hook.get_conflict()
    if conflict is not None:
        adopted = await awaitWorkflowResult(conflict.run_id)
        return {
            "role": "duplicate",
            "conflictRunId": conflict.run_id,
            "adopted": adopted,
        }

    payload = await hook
    return {"role": "owner", "marker": marker, "value": payload.value}


@app.step
async def forwardPayloadToOwner(token: str, message: str) -> None:
    await SignalPayload(message=message).resume(token)


@app.workflow
async def hookSignalOwnerWorkflow(token: str, message: str) -> dict:
    hook = SignalPayload.wait(token=token)
    conflict = await hook.get_conflict()
    if conflict is not None:
        await forwardPayloadToOwner(token, message)
        return {"role": "duplicate", "forwardedTo": conflict.run_id}

    payload = await hook
    return {"role": "owner", "received": payload.message}


@app.workflow
async def hookDisposeTestWorkflow(token: str, customData: str) -> dict:
    hook = MessagePayload.wait(token=token, metadata={"customData": customData})
    payload = await hook
    message, customDataResult = payload.message, payload.customData

    # Releases the token here rather than at run completion, which is what lets
    # the test's second run claim it while this one is still sleeping.
    hook.dispose()
    await sleep("5s")

    return {
        "message": message,
        "customData": customDataResult,
        "disposed": True,
        "hookDisposeTestData": "workflow_completed",
    }


##########################################################
# errorRetryCustomDelay
#
# The third of the TypeScript retry block's fixtures, and the one that needed
# two things at once: `RetryableError(retry_after=…)` to steer the wait, and
# `StepInfo.step_started_at` to measure it. `step_started_at` is when the
# *first* attempt began, so `now - step_started_at` on attempt 2 is how long the
# step has been going across the retry — which is what the test bounds at 10s.
#
# Wall clock rather than the workflow clock, because this runs in a step: the
# deterministic clock is a replay construct and would report the same instant on
# both attempts.


@app.step
async def throwRetryableError() -> dict:
    metadata = get_step_metadata()
    if metadata.attempt == 1:
        raise RetryableError("Retryable error", retry_after="10s")
    startedAt = int(metadata.step_started_at.timestamp() * 1000)
    return {
        "attempt": metadata.attempt,
        "duration": time.time_ns() // 1_000_000 - startedAt,
    }


@app.workflow
async def errorRetryCustomDelay() -> dict:
    return await throwRetryableError()


##########################################################
# setAttributesWorkflow
# setAttributesInsideStepWorkflow
# setAttributesFireAndForgetWorkflow
# setAttributesParallelWorkflow
# setAttributesThrowsAfterWorkflow
# setAttributesValidationWorkflow
#
# Plaintext key/value metadata on the run, and the whole `setAttributes` block in
# one go now that `set_attributes()` exists. Six fixtures covering the axes the
# implementation can get wrong independently: from the workflow body, from a step
# body, unawaited, concurrently over disjoint keys, on a run that then fails, and
# with every input the validator is supposed to reject.
#
# Two Python-shaped details, neither of them a workaround:
#
# - **`undefined` is `None`.** `setAttributes({ source: undefined })` removes the
#   key; the Python spelling is `{"source": None}`, which is what the SDK's
#   `Mapping[str, str | None]` signature already says.
# - **Fire-and-forget is a scheduled task.** `set_attributes()` is an async
#   function, so Python has to schedule the coroutine to start it without
#   awaiting its completion. The next workflow suspension gives those tasks a
#   turn to register their writes, which is the `void setAttributes(...)` shape
#   this fixture exercises.


@app.workflow
async def setAttributesWorkflow(input: int) -> int:
    await set_attributes({"phase": "init", "source": "workflow-body"})
    tripled = input * 3
    await set_attributes({"phase": "done"})
    # `None` removes the key, the way `undefined` does on the TypeScript side.
    await set_attributes({"source": None})
    return tripled


@app.step
async def setAttributesFromStep(input: int) -> int:
    await set_attributes(
        {"phase": "step-started", "source": "step-body", "input": str(input)}
    )
    await set_attributes({"phase": "step-done"})
    return input * 4


@app.workflow
async def setAttributesInsideStepWorkflow(input: int) -> int:
    return await setAttributesFromStep(input)


@app.workflow
async def setAttributesFireAndForgetWorkflow() -> str:
    # Deliberately scheduled and not awaited: the write starts now and lands at
    # the next suspension, matching `void setAttributes(...)` in TypeScript.
    asyncio.create_task(set_attributes({"phase": "init", "mode": "fire-and-forget"}))
    await sleep("100ms")
    asyncio.create_task(set_attributes({"phase": "mid"}))
    await sleep("100ms")
    # This final scheduled write is the unsupported edge: the workflow body
    # returns before the coroutine starts, so the runtime has nothing to drain.
    asyncio.create_task(set_attributes({"phase": "done"}))
    return "completed"


@app.workflow
async def setAttributesParallelWorkflow() -> str:
    await asyncio.gather(
        set_attributes({"a": "1"}),
        set_attributes({"b": "2"}),
        set_attributes({"c": "3"}),
    )
    return "done"


@app.workflow
async def setAttributesThrowsAfterWorkflow() -> None:
    await set_attributes({"phase": "about-to-fail", "reason": "intentional"})
    raise FatalError("intentional failure to test attribute persistence")


@app.workflow
async def setAttributesValidationWorkflow() -> dict:
    outcomes = {}

    async def attempt(label: str, attrs) -> None:
        try:
            await set_attributes(attrs)
            outcomes[label] = "no-error"
        except Exception as e:
            outcomes[label] = f"{type(e).__name__}: {e}"

    await attempt("reserved", {"$system": "nope"})
    await attempt("emptyKey", {"": "v"})
    await attempt("keyTooLong", {"k" * 257: "v"})
    await attempt("valueTooLong", {"note": "v" * 257})
    # The cap is bytes, not characters: 200 two-byte characters is 400 bytes.
    await attempt("valueTooManyBytes", {"note": "é" * 200})
    await attempt("overCap", {f"k{i}": "v" for i in range(65)})
    await attempt("nonObject", "phase=init")

    # The run must remain healthy after every rejected call.
    await set_attributes({"phase": "validated"})
    return outcomes
