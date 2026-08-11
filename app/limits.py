"""Refusing an oversized body before anything reads it.

The check has to happen here, in middleware, and not in the tool that receives
the file: Starlette parses a whole multipart body into a spooled temp file
*before* the endpoint runs, so a cap applied in the handler fires only after the
bytes have arrived and been written. Starlette 0.41 offers no streaming size cap
of its own (`form()` takes max_files/max_fields and nothing else).

So the enforcing check is Content-Length, refused before the body is touched.
That is only as good as the header, which is why a body with **no**
Content-Length is refused too:

  - nginx buffers a proxied request body and sets an accurate Content-Length, so
    behind gatekeeper the header is a fact rather than a claim, and a chunked
    upload never reaches us in that shape.
  - Which leaves lying about it, or omitting it — both of which require talking
    to :8080 directly, which is precisely what "no published ports" prevents.
    The same reasoning is what makes X-Auth-User trustworthy, and it fails in
    the same way if anything ever publishes that port.

A second, weaker check still runs in the tool itself while it copies the upload
out of the spool. It cannot stop the transfer by then, but it does stop
Ghostscript being handed the file.
"""

import os

from starlette.responses import JSONResponse, PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", 100 * 1024 * 1024))

# GET and HEAD carry no body worth measuring. DELETE and OPTIONS are measured
# like anything else — an empty body passes trivially.
BODILESS_METHODS = frozenset({"GET", "HEAD"})


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int = MAX_UPLOAD_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in BODILESS_METHODS:
            await self.app(scope, receive, send)
            return

        declared = _header(scope, b"content-length")
        if declared is None:
            await self._refuse(
                scope, receive, send, 411,
                "That request did not say how large it was.",
            )
            return

        try:
            size = int(declared)
        except ValueError:
            await self._refuse(scope, receive, send, 400, "Malformed Content-Length.")
            return

        if size > self.max_bytes:
            mb = self.max_bytes // 1024 // 1024
            await self._refuse(
                scope, receive, send, 413,
                f"That file is larger than the {mb} MB limit.",
            )
            return

        await self.app(scope, receive, send)

    async def _refuse(self, scope, receive, send, status: int, message: str) -> None:
        accept = _header(scope, b"accept") or b""
        response = (
            PlainTextResponse(message, status_code=status)
            if b"text/html" in accept
            else JSONResponse({"error": message}, status_code=status)
        )
        await response(scope, receive, send)


def _header(scope: Scope, name: bytes) -> bytes | None:
    for key, value in scope["headers"]:
        if key == name:
            return value
    return None
