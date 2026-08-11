"""CSRF, in two layers, because each covers what the other cannot.

1. **Fetch metadata**, in middleware, on every unsafe method. `Sec-Fetch-Site`
   and `Origin` say where a request was triggered from, and a browser will not
   let a page lie about either. This runs before the body is touched, so a
   cross-site POST is refused without a 100MB upload being parsed first — and it
   applies to every route automatically, so a new tool cannot forget it.

2. **A double-submit token**, in the form. The check above is only as good as
   the headers a browser sends; a client that sends neither would sail through
   it. The token is minted here, set as a cookie, and echoed in a hidden field —
   an attacker's page can cause the POST but cannot read the cookie to fill the
   field in.

This app stores no session state of its own (`auth` owns sessions), which is
exactly what double-submit is for: the cookie *is* the server side.
"""

import secrets

from starlette.datastructures import FormData
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

# __Host- is enforced by the browser: same host only, Secure, Path=/, no Domain.
# A cookie records nothing about who set it, so without the prefix a sibling
# subdomain could plant one we would read as our own. Path is / and not /tools —
# the prefix requires it, and it is the gateway's namespace anyway.
COOKIE = "__Host-toolshed-csrf"
FIELD = "csrf"

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


def token_for(request: Request) -> str:
    """The caller's token: the one they already have, or a new one.

    Reused rather than rotated per render — a form left open in a second tab
    must not be invalidated by a reload in the first.
    """
    existing = request.cookies.get(COOKIE)
    if existing:
        return existing
    minted = request.scope.get("toolshed_csrf_minted")
    if not minted:
        minted = secrets.token_urlsafe(32)
        request.scope["toolshed_csrf_minted"] = minted
    return minted


def attach(request: Request, response) -> None:
    """Persist a freshly minted token. Called by render(), once per page."""
    minted = request.scope.get("toolshed_csrf_minted")
    if minted:
        response.set_cookie(COOKIE, minted, path="/", httponly=True,
                            secure=True, samesite="Lax")


def check(request: Request, form: FormData) -> bool:
    """Compare the submitted field against the cookie, in constant time."""
    cookie = request.cookies.get(COOKIE, "")
    submitted = form.get(FIELD, "")
    if not cookie or not isinstance(submitted, str):
        return False
    return secrets.compare_digest(submitted, cookie)


class CsrfMiddleware:
    """Layer 1. Refuses a cross-site unsafe request before its body is read."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in SAFE_METHODS:
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        site = request.headers.get("sec-fetch-site")
        if site is not None and site not in ("same-origin", "none"):
            await self._refuse(request, send)
            return

        origin = request.headers.get("origin")
        if origin is not None and origin != _own_origin(request):
            await self._refuse(request, send)
            return

        await self.app(scope, receive, send)

    async def _refuse(self, request: Request, send: Send) -> None:
        # Deliberately not a redirect: this is not "you are signed out", it is
        # "that request did not come from this site", and there is nowhere
        # useful to send it.
        body = "Cross-site request refused."
        response = (
            PlainTextResponse(body, status_code=403)
            if "text/html" in request.headers.get("accept", "")
            else JSONResponse({"error": body}, status_code=403)
        )
        await response(request.scope, request.receive, send)


def _own_origin(request: Request) -> str:
    """What a browser on this site would send as Origin.

    Built from the *forwarded* scheme and the Host the gateway passed through,
    because the hop from nginx to here is plain HTTP — reading the socket's own
    scheme would make every real request look cross-origin.
    """
    scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("host", "")
    return f"{scheme}://{host}"
