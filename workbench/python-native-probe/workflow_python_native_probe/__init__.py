from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypeVar

from . import _native


ERROR_MARKER = "WORKFLOW_NATIVE_ERROR:"
EXPECTED_ADAPTER_PROTOCOL_VERSION = 1
T = TypeVar("T")


class WorkflowNativeError(Exception):
    def __init__(
        self,
        *,
        code: str,
        kind: str,
        message: str,
        retryable: bool,
        details: Mapping[str, Any],
    ) -> None:
        super().__init__(message)
        self.code = code
        self.kind = kind
        self.retryable = retryable
        self.details = dict(details)


def _map_native_error(error: Exception) -> Exception:
    message = str(error)
    marker = message.find(ERROR_MARKER)
    if marker == -1:
        return error
    try:
        envelope = json.loads(message[marker + len(ERROR_MARKER) :])
        return WorkflowNativeError(
            code=envelope.get("code", envelope["kind"]),
            kind=envelope["kind"],
            message=envelope["message"],
            retryable=envelope["retryable"],
            details=envelope["details"],
        )
    except (KeyError, TypeError, ValueError):
        return error


async def _call_native(operation: Callable[[], T]) -> T:
    try:
        return await asyncio.to_thread(operation)
    except Exception as error:
        mapped = _map_native_error(error)
        if mapped is error:
            raise
        raise mapped from error


class SqliteWorldProbe:
    def __init__(self, path: str) -> None:
        self._native = _native.NativeSqliteWorld(path)
        self._closed = False
        self._close_task: asyncio.Task[bool] | None = None
        self._in_flight: set[asyncio.Task[Any]] = set()

    def migrate(self) -> Awaitable[None]:
        return self._run(self._native.migrate)

    def create_resilient_run_started(
        self,
        *,
        run_id: str,
        spec_version: int,
        deployment_id: str,
        workflow_name: str,
        input: bytes | bytearray | memoryview,
        execution_context: Mapping[str, Any] | None = None,
        attributes: Mapping[str, str] | None = None,
        allow_reserved_attributes: bool = False,
        encryption_public_key: str | None = None,
    ) -> Awaitable[dict[str, Any]]:
        owned_input = bytes(input)
        attributes_json = (
            None
            if attributes is None
            else json.dumps(attributes, separators=(",", ":"))
        )
        return self._run(
            lambda: json.loads(
                self._native.create_resilient_run_started(
                    run_id,
                    spec_version,
                    deployment_id,
                    workflow_name,
                    owned_input,
                    execution_context,
                    attributes_json,
                    allow_reserved_attributes,
                    encryption_public_key,
                )
            )
        )

    def snapshot_contract(self, run_id: str) -> Awaitable[dict[str, Any]]:
        return self._run(lambda: json.loads(self._native.snapshot_contract(run_id)))

    async def close(self) -> bool:
        if self._closed:
            if self._close_task is not None:
                await self._close_task
            return False
        self._closed = True

        async def drain() -> bool:
            await asyncio.gather(*tuple(self._in_flight), return_exceptions=True)
            return self._native.close()

        self._close_task = asyncio.create_task(drain())
        return await self._close_task

    async def __aenter__(self) -> SqliteWorldProbe:
        return self

    async def __aexit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: object | None,
    ) -> None:
        await self.close()

    def _run(self, operation: Callable[[], T]) -> asyncio.Task[T]:
        if self._closed:

            async def reject_closed() -> T:
                raise WorkflowNativeError(
                    code="closed",
                    kind="closed",
                    message="SQLite World handle is closed",
                    retryable=False,
                    details={},
                )

            return asyncio.create_task(reject_closed())

        async def invoke() -> T:
            return await _call_native(operation)

        task = asyncio.create_task(invoke())
        self._in_flight.add(task)
        task.add_done_callback(self._in_flight.discard)
        return task


async def native_delay_probe(milliseconds: int) -> None:
    await _call_native(lambda: _native.native_delay_probe(milliseconds))


async def native_panic_probe() -> None:
    await _call_native(_native.native_panic_probe)


native_info: dict[str, Any] = json.loads(_native.native_info())
if native_info["adapterProtocolVersion"] != EXPECTED_ADAPTER_PROTOCOL_VERSION:
    raise RuntimeError(
        "Native adapter protocol "
        f"{native_info['adapterProtocolVersion']} is incompatible with Python "
        f"adapter protocol {EXPECTED_ADAPTER_PROTOCOL_VERSION}"
    )


NativeSqliteWorld = _native.NativeSqliteWorld
NativeTypeTagSentinel = _native.NativeTypeTagSentinel
round_trip_context = _native.round_trip_context

__all__ = [
    "NativeSqliteWorld",
    "NativeTypeTagSentinel",
    "SqliteWorldProbe",
    "WorkflowNativeError",
    "native_delay_probe",
    "native_info",
    "native_panic_probe",
    "round_trip_context",
]
