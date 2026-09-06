from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from workflow_python_native_probe import (
    NativeSqliteWorld,
    NativeTypeTagSentinel,
    SqliteWorldProbe,
    WorkflowNativeError,
    native_delay_probe,
    native_info,
    round_trip_context,
)


PACKAGE_DIRECTORY = Path(__file__).resolve().parent
FIXTURE_PATH = (
    PACKAGE_DIRECTORY.parents[1]
    / "fixtures"
    / "world-contract"
    / "v1"
    / "resilient-run-start.json"
)


async def assert_rejects(awaitable, *, kind: str) -> WorkflowNativeError:
    try:
        await awaitable
    except WorkflowNativeError as error:
        assert error.code == kind
        assert error.kind == kind
        return error
    raise AssertionError(f"operation should reject with {kind!r}")


async def main() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    event = fixture["when"]["event"]
    event_data = event["eventData"]

    assert fixture["fixtureVersion"] == 1
    assert fixture["name"] == "resilient-run-start-synthesizes-created"
    assert fixture["requires"] == ["run-started-preload"]
    assert fixture["persistedSpecVersion"] == event["specVersion"]
    assert fixture["given"]["storage"] == "empty"
    assert fixture["when"]["operation"] == "events.create"
    assert event["eventType"] == "run_started"
    assert native_info["adapterProtocolVersion"] == 1
    assert native_info["pythonAbi"] == "abi3-py39"
    assert native_info["sqliteVersion"] == "3.53.2"

    try:
        NativeSqliteWorld.close(NativeTypeTagSentinel())
    except TypeError:
        pass
    else:
        raise AssertionError("native methods must reject a wrong receiver type")

    panic_probe = subprocess.run(
        [sys.executable, str(PACKAGE_DIRECTORY / "panic_probe.py")],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "native panic became an awaitable exception" in panic_probe.stdout
    assert "intentional native task panic probe" in panic_probe.stderr

    delay_task = asyncio.create_task(native_delay_probe(200))
    await asyncio.sleep(0.05)
    assert not delay_task.done(), (
        "native call blocked the event loop or retained the GIL"
    )
    await delay_task

    shared_context_part = {"bytes": bytes([0, 1, 255])}
    portable_context = round_trip_context(
        {"left": shared_context_part, "right": shared_context_part}
    )
    assert portable_context["left"]["bytes"] == bytes([0, 1, 255])
    assert portable_context["right"]["bytes"] == bytes([0, 1, 255])
    assert portable_context["left"] is not portable_context["right"]
    cyclic_context: dict[str, object] = {}
    cyclic_context["self"] = cyclic_context
    try:
        round_trip_context(cyclic_context)
    except Exception as error:
        assert "cyclic references are not supported" in str(error)
    else:
        raise AssertionError("cyclic context must be rejected")

    with tempfile.TemporaryDirectory(prefix="world-native-") as directory:
        database_path = Path(directory) / "world.sqlite"

        unmigrated = SqliteWorldProbe(str(database_path))
        assert not database_path.exists()
        await assert_rejects(
            unmigrated.snapshot_contract(fixture["when"]["runId"]),
            kind="not_migrated",
        )
        await unmigrated.close()
        assert not database_path.exists()

        world = SqliteWorldProbe(str(database_path))
        assert not database_path.exists()
        await world.migrate()
        assert database_path.exists()

        input_buffer = bytearray(base64.b64decode(event_data["input"]["$bytes"]))
        operation = world.create_resilient_run_started(
            run_id=fixture["when"]["runId"],
            spec_version=event["specVersion"],
            deployment_id=event_data["deploymentId"],
            workflow_name=event_data["workflowName"],
            input=input_buffer,
            execution_context=event_data["executionContext"],
            attributes=event_data["attributes"],
            allow_reserved_attributes=event_data["allowReservedAttributes"],
            encryption_public_key=event_data["encryptionPublicKey"],
        )
        input_buffer[:] = bytes([42]) * len(input_buffer)
        actual = await operation
        assert actual == fixture["then"]

        retry = await world.create_resilient_run_started(
            run_id=fixture["when"]["runId"],
            spec_version=event["specVersion"],
            deployment_id=event_data["deploymentId"],
            workflow_name=event_data["workflowName"],
            input=base64.b64decode(event_data["input"]["$bytes"]),
            execution_context=event_data["executionContext"],
            attributes=event_data["attributes"],
            allow_reserved_attributes=event_data["allowReservedAttributes"],
            encryption_public_key=event_data["encryptionPublicKey"],
        )
        assert retry["result"]["event"] is None
        assert len(retry["events"]) == 2

        assert await world.close() is True
        assert await world.close() is False
        await assert_rejects(
            world.snapshot_contract(fixture["when"]["runId"]), kind="closed"
        )

        async with SqliteWorldProbe(str(database_path)) as reopened:
            durable = await reopened.snapshot_contract(fixture["when"]["runId"])
            assert durable == {
                "run": fixture["then"]["run"],
                "events": fixture["then"]["events"],
            }

        direct_database_path = Path(directory) / "direct.sqlite"
        direct = NativeSqliteWorld(str(direct_database_path))
        direct.migrate()
        direct_context = {
            **event_data["executionContext"],
            "binary": bytes([0, 1, 255]),
        }
        direct_actual = json.loads(
            direct.create_resilient_run_started(
                f"{fixture['when']['runId'][:-1]}B",
                event["specVersion"],
                event_data["deploymentId"],
                event_data["workflowName"],
                base64.b64decode(event_data["input"]["$bytes"]),
                direct_context,
                json.dumps(event_data["attributes"]),
                event_data["allowReservedAttributes"],
                event_data["encryptionPublicKey"],
            )
        )
        assert direct_actual["run"]["input"] == fixture["then"]["run"]["input"]
        assert direct_actual["run"]["executionContext"]["binary"] == [0, 1, 255]
        assert direct.close() is True

        draining_database_path = Path(directory) / "draining.sqlite"
        draining = SqliteWorldProbe(str(draining_database_path))
        migration_settled = False
        pending_migration = draining.migrate()

        def mark_settled(_task: asyncio.Task[None]) -> None:
            nonlocal migration_settled
            migration_settled = True

        pending_migration.add_done_callback(mark_settled)
        assert await draining.close() is True
        assert migration_settled is True
        await pending_migration
        assert draining_database_path.exists()

    print(f"Python native probe passed (SQLite {native_info['sqliteVersion']})")


asyncio.run(main())
