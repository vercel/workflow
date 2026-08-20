"""ASGI adapter that puts a Python workflow app behind the routes the
TypeScript e2e suite drives.

The Python SDK has no `.well-known/workflow/v1` HTTP surface: deployed Python is
invoked by platform queue triggers on `/_py_workflows/<name>`, so it ships no
manifest generator, no route table, and no concrete `HTTPRequest`. This file
supplies all three. They live here rather than in the SDK because they implement
a contract the SDK does not claim to serve. What the SDK does own is the flow
route's *behaviour*: `workflow_entrypoint` knows the path it belongs on
(`runtime.FLOW_ROUTE`) and answers the `?__health` probe itself.

What it does *not* do is translate any protocol. `LocalWorld.create_queue_handler`
already reads exactly the headers `@workflow/world-local` sends and answers
`{"ok": true}`, and both sides read `WORKFLOW_LOCAL_DATA_DIR` with byte-compatible
file formats. So the whole adapter is routing plus a manifest.

Only the *first* workflow trigger of a run arrives over HTTP. `LocalWorld.queue`
publishes to an embedded in-process queue service, so every step invocation and
workflow continuation after that stays inside this process.
"""

from __future__ import annotations

import importlib
import json
from typing import Any, AsyncIterator, Callable

import httpx
from vercel.workflow._internal import world as w
from vercel.workflow._internal.runtime import FLOW_ROUTE, workflow_entrypoint

# The fixture module is named to match `workbench/example/workflows/99_e2e.ts`,
# which a plain `import` statement cannot express — a module name may not start
# with a digit. importlib has no such restriction.
FIXTURES_MODULE = "workflows.99_e2e"
fixtures = importlib.import_module(FIXTURES_MODULE)
registry = fixtures.app

# One entrypoint serves both replays and step invocations: since vercel-py #251
# a step rides the `__wkf_workflow_*` topic as a `stepId` on the invoke payload,
# matching the TypeScript SDK. Calling this is also what subscribes the handler
# to that topic, which is how in-process dispatch gets delivered.
flow_handler = workflow_entrypoint(registry)

# The SDK's own constant, so the two agree by construction. Everything else this
# app serves is a sibling of it.
ROUTE_BASE = FLOW_ROUTE.rsplit("/", 1)[0]
MANIFEST_VERSION = "1.0.0"


def _module_to_file(module: str) -> str:
    """`workflows.99_e2e` -> `workflows/99_e2e.py`.

    The suite looks fixtures up by their TypeScript path (`workflows/99_e2e.ts`)
    and matches manifest keys by suffix after stripping the extension, so the
    stem has to agree even though the extension does not.
    """
    return f"{module.replace('.', '/')}.py"


def build_manifest() -> dict[str, Any]:
    """Emit the manifest from the registry.

    `Workflows` exposes no enumeration API, so this reads the private dicts.
    Publishing `qualname -> workflow_id` straight from them is the reason the
    fixtures use the TS functions' camelCase names: there is no name mapping to
    maintain, and a fixture that gets renamed or unregistered disappears from the
    manifest instead of silently pointing at the wrong ID.
    """
    workflows: dict[str, dict[str, Any]] = {}
    steps: dict[str, dict[str, Any]] = {}

    for workflow in registry._workflows.values():
        file = _module_to_file(workflow.module)
        workflows.setdefault(file, {})[workflow.qualname] = {
            "workflowId": workflow.workflow_id
        }

    for step in registry._steps.values():
        # Step names are `step//{module}//{qualname}`.
        _, module, qualname = step.name.split("//", 2)
        file = _module_to_file(module)
        steps.setdefault(file, {})[qualname] = {"stepId": step.name}

    return {"version": MANIFEST_VERSION, "workflows": workflows, "steps": steps}


class AsgiRequest(w.HTTPRequest):
    """The `HTTPRequest` the SDK's flow handler expects, over an ASGI scope."""

    def __init__(self, scope: dict[str, Any], receive: Callable) -> None:
        self._scope = scope
        self._headers = httpx.Headers(
            [(k.decode("latin-1"), v.decode("latin-1")) for k, v in scope["headers"]]
        )
        self._receive = receive

    @property
    def method(self) -> str:
        return self._scope["method"]

    @property
    def url(self) -> str:
        # The request target as it arrived, which is what the health branch
        # splits: it reports `endpoint` from the path, so an origin here would
        # make this app claim a path it does not serve.
        query = self._scope.get("query_string", b"").decode("latin-1")
        return self._scope["path"] + (f"?{query}" if query else "")

    @property
    def headers(self) -> httpx.Headers:
        return self._headers

    async def aiter_bytes(self, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        while True:
            message = await self._receive()
            if message["type"] != "http.request":
                break
            body = message.get("body") or b""
            if body:
                yield body
            if not message.get("more_body"):
                break


async def _send_json(send: Callable, status: int, payload: Any) -> None:
    body = json.dumps(payload).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def app(scope: dict[str, Any], receive: Callable, send: Callable) -> None:
    if scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await w.get_world().aclose()
                await send({"type": "lifespan.shutdown.complete"})
                return

    if scope["type"] != "http":
        return

    path = scope["path"]
    method = scope["method"]
    query = scope.get("query_string", b"").decode()

    if path == f"{ROUTE_BASE}/manifest.json" and method in ("GET", "HEAD"):
        await _send_json(send, 200, build_manifest())
        return

    # Two things share this route, and the handler tells them apart itself:
    # a queue delivery (POST) and the `?__health` probe that dev-server port
    # discovery sends to decide whether a port is serving a workflow app
    # (HEAD, reading only the status). Since vercel-py #292 the probe is the
    # SDK's, matching `withHealthCheck` in `@workflow/core` down to the CORS
    # headers, so this app only routes. The other, stream-based `healthCheck()`
    # protocol needs nothing here at all: it arrives as a queue delivery, and
    # `workflow_handler` answers it before it looks for a run.
    if path == FLOW_ROUTE and (method == "POST" or "__health" in query):
        response = await flow_handler(AsgiRequest(scope, receive))
        await send(
            {
                "type": "http.response.start",
                "status": response.status,
                "headers": [
                    (k.encode(), v.encode()) for k, v in response.headers.items()
                ]
                + [(b"content-length", str(len(response.body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": response.body})
        return

    await _send_json(send, 404, {"error": f"No route for {method} {path}"})
