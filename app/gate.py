"""The sign-in gate — deliberately not implemented yet.

Everything in this app is meant to sit behind sign-in; there is no public path
like tv-webui's `/media/live`. That makes the gate one check in one place, which
is why this file exists now, empty, rather than being retrofitted later into
each router.

What it will do, when it is wired up:

  - Ask `auth:8080` on the `edge` network who the caller is, per request. Never
    cache the answer: web sessions expire at the coming Saturday 00:00
    Europe/Budapest and WiFi identity is re-derived per request, both of which
    are `auth`'s business, not ours.
  - Refuse in the shape the caller expects. `is_navigation()` below is that
    decision, and it is already used by the PDF tool for its own errors, so the
    two cannot drift:
      * browser navigation -> 302 to `login_url()`, which carries the gateway
        prefix in `next` — otherwise it aims at the gateway's root.
      * background XHR / WebSocket -> a bare 401. This is the whole reason the
        gate moved out of nginx: `auth_request` redirected both and handed
        `fetch()` a login page as a cheerful 200.

What it must *not* do: decide anything from `X-Auth-User`. That header is
trustworthy only because nginx overwrites it on every proxied hop, a guarantee
that evaporates the moment anything can reach this app's port directly — which
is why publishing a port is a security bug and not untidiness.

`X-Auth-User` is *not* the decision. gatekeeper sets it on every proxied hop
(empty where ungated) so a client cannot forge it, but it is for display only —
`current_user()` reads it for the "signed in as …" line and nothing else.
"""

from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from app.links import DEFAULT_NEXT, safe_next  # noqa: F401  (re-exported)
from app.prefix import url

def login_url(request: Request) -> str:
    """`/login?next=…`, with the next pointing back *here*.

    `/login` is the gateway's own route, so it is not built through url() — but
    the destination is one of ours and must carry the prefix, or it aims at the
    gateway's root.
    """
    from urllib.parse import quote

    target = url(request, safe_next(request.url.path))
    if request.url.query:
        target = f"{target}?{request.url.query}"
    return f"/login?next={quote(target, safe='')}"


def is_navigation(request: Request) -> bool:
    """True when a refusal should be a redirect rather than a bare 401.

    `Sec-Fetch-Mode: navigate` is exactly the question being asked — the browser
    tells us whether this is a top-level navigation or a background fetch. Older
    browsers send no Sec-Fetch-* at all; those fall back to Accept, where a
    navigation asks for HTML and `fetch()` here is told to ask for JSON.
    """
    mode = request.headers.get("sec-fetch-mode")
    if mode:
        return mode == "navigate"
    return "text/html" in request.headers.get("accept", "")


def current_user(request: Request) -> str:
    """Display only. The authorisation decision is the `auth` call, not this."""
    return request.headers.get("x-auth-user", "")


class AuthGate:
    """Placeholder. Lets every request through, on purpose.

    Wiring the real check happens here and nowhere else: call `auth`, and on a
    refusal short-circuit with the shape `is_navigation()` picks.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await self.app(scope, receive, send)
