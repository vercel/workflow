"""ASGI adapter that puts a Python workflow app behind the routes the
TypeScript e2e suite drives.

The Python SDK owns the workflow and manifest handlers, their public route
constants, and the abstract HTTP request/response types. This file only adapts
those handlers to a bare ASGI app; a framework integration would do the same
routing itself.

It does not translate any protocol. `LocalWorld.create_queue_handler`
already reads exactly the headers `@workflow/world-local` sends and answers
`{"ok": true}`, and both sides read `WORKFLOW_LOCAL_DATA_DIR` with byte-compatible
file formats.

Only the *first* workflow trigger of a run arrives over HTTP. `LocalWorld.queue`
publishes to an embedded in-process queue service, so every step invocation and
workflow continuation after that stays inside this process.
"""

from __future__ import annotations

import importlib
from typing import Any, AsyncIterator, Callable

import httpx
from vercel.workflow import ENDPOINT_PATH, MANIFEST_PATH, HTTPRequest, HTTPResponse
from vercel.workflow._internal import world as w

# The fixture module is named to match `workbench/example/workflows/99_e2e.ts`,
# which a plain `import` statement cannot express — a module name may not start
# with a digit. importlib has no such restriction.
FIXTURES_MODULE = "workflows.99_e2e"
fixtures = importlib.import_module(FIXTURES_MODULE)
registry = fixtures.app
flow_handler = registry.http_handler
manifest_handler = registry.manifest_handler


class AsgiRequest(HTTPRequest):
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


async def _send_response(send: Callable, response: HTTPResponse) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": response.status,
            "headers": [
                (key.encode(), value.encode()) for key, value in response.headers.items()
            ]
            + [(b"content-length", str(len(response.body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": response.body})


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

    if path == MANIFEST_PATH and method in ("GET", "HEAD"):
        response = await manifest_handler(AsgiRequest(scope, receive))
        await _send_response(send, response)
        return

    # Two things share this route, and the handler tells them apart itself:
    # a queue delivery (POST) and the `?__health` probe that dev-server port
    # discovery sends to decide whether a port is serving a workflow app
    # (HEAD, reading only the status). Since vercel-py #292 the probe is the
    # SDK's, matching `withHealthCheck` in `@workflow/core` down to the CORS
    # headers, so this app only routes. The other, stream-based `healthCheck()`
    # protocol needs nothing here at all: it arrives as a queue delivery, and
    # `workflow_handler` answers it before it looks for a run.
    if path == ENDPOINT_PATH and (method == "POST" or "__health" in query):
        response = await flow_handler(AsgiRequest(scope, receive))
        await _send_response(send, response)
        return

    await _send_response(
        send,
        HTTPResponse.json({"error": f"No route for {method} {path}"}, status=404),
    )
