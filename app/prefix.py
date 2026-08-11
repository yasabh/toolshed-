"""Where this app thinks it lives.

gatekeeper strips `/tools` before proxying (`rewrite ^/tools/(.*)$ /$1 break;`),
so the path this app routes on is already unprefixed — and every URL it *emits*
must have the prefix put back, or the browser aims at the gateway's root and
lands on tv-webui's catch-all `location /`.

The prefix is deliberately NOT installed as ASGI `root_path`. Whether Starlette
strips root_path from `scope["path"]` before matching has changed across
versions, and getting it wrong routes everything to 404 in a way that only shows
up behind the proxy. Routing here matches the plain stripped path, and every
emitted URL goes through `url()`. One rule, one place, no version-dependent
behaviour.
"""

from starlette.types import ASGIApp, Receive, Scope, Send

HEADER = b"x-forwarded-prefix"


class PrefixMiddleware:
    """Read X-Forwarded-Prefix once per request and park it in the scope."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            prefix = ""
            for name, value in scope["headers"]:
                if name == HEADER:
                    # A prefix of "/" is the same as none, and a trailing slash
                    # would double up against the leading slash of every path.
                    prefix = value.decode("latin-1").rstrip("/")
                    break
            scope["toolshed_prefix"] = prefix

            # Normalise `/pdf/` to `/pdf` here rather than letting Starlette's
            # redirect_slashes do it (main.py turns that off). Its redirect is
            # built from the unprefixed path and would send the browser to
            # `/pdf` at the gateway root — straight into tv-webui's catch-all.
            # Rewriting the path means there is no redirect to get wrong.
            path = scope.get("path", "")
            if len(path) > 1 and path.endswith("/"):
                scope["path"] = path.rstrip("/") or "/"

        await self.app(scope, receive, send)


def prefix_of(request) -> str:
    """`/tools` behind the gateway, `` when reached directly."""
    return request.scope.get("toolshed_prefix", "")


def url(request, path: str) -> str:
    """Turn an app-internal path into one the browser can follow.

    `path` is always written as this app sees it (`/pdf`, `/static/style.css`) —
    the prefix is the gateway's business, never hardcoded at a call site.
    """
    if not path.startswith("/"):
        raise ValueError(f"url() takes an app-absolute path, got {path!r}")
    return f"{prefix_of(request)}{path}"
