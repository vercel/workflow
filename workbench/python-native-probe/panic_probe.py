from __future__ import annotations

import asyncio

from workflow_python_native_probe import WorkflowNativeError, native_panic_probe


async def main() -> None:
    try:
        await native_panic_probe()
    except WorkflowNativeError as error:
        assert error.kind == "panic"
        assert "intentional native task panic probe" in str(error)
    else:
        raise AssertionError("native panic should become a Python exception")
    print("native panic became an awaitable exception")


asyncio.run(main())
