"""The shell: a sidebar of tools, and one route per tool."""

from pathlib import Path

from fastapi import FastAPI, Request
from starlette.responses import RedirectResponse
from starlette.staticfiles import StaticFiles

from app.csrf import CsrfMiddleware
from app.gate import AuthGate
from app.limits import BodyLimitMiddleware
from app.prefix import PrefixMiddleware, url
from app.render import render
from app.tools import TOOLS

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# Starlette's trailing-slash redirect emits an absolute URL built from the
# *stripped* path, which behind the gateway points at its root instead of at the
# prefix. PrefixMiddleware normalises the path instead, so this never fires.
app.router.redirect_slashes = False

# add_middleware pushes onto the front, so the LAST one added is the outermost.
# Read this list bottom-up to see the order a request meets them:
#
#   PrefixMiddleware   the prefix has to be in the scope before anything builds
#                      a URL from it — the gate's `next=` in particular
#   SecurityHeaders    wraps every response, including the refusals below
#   BodyLimitMiddleware  refuse an oversized upload before its body is read
#   CsrfMiddleware     refuse a cross-site POST before its body is read
#   AuthGate           who the caller is (not implemented yet)
app.add_middleware(AuthGate)
app.add_middleware(CsrfMiddleware)
app.add_middleware(BodyLimitMiddleware)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")

    path = request.url.path
    if path.startswith("/static/"):
        # Static assets carry no identity, and `no-store` on them would be
        # actively harmful: the vendored Ghostscript is 15.4 MB, and forbidding
        # storage means re-downloading it on every single page load.
        #
        # The vendored build only changes when test/vendor.sh is re-run, so it
        # is cached hard. Our own CSS and JS revalidate instead — they are a few
        # kB, so an ETag round-trip is free and an edit shows up at once.
        # StaticFiles supplies the ETag either way, so even a miss is a 304.
        response.headers.setdefault(
            "Cache-Control",
            "public, max-age=604800" if path.startswith("/static/vendor/")
            else "no-cache",
        )
    else:
        # Every page carries a CSRF token and, once the gate is wired, an
        # identity — none of that may be stored by a browser or an intermediary.
        # Same set as auth's, so the two ends of a sign-in behave alike.
        response.headers.setdefault("Cache-Control", "no-store")
    return response


app.add_middleware(PrefixMiddleware)

app.mount(
    "/static",
    StaticFiles(directory=str(Path(__file__).parent / "static")),
    name="static",
)

for tool in TOOLS:
    app.include_router(tool.router, prefix=tool.path)


@app.get("/")
async def index(request: Request):
    # No landing page: with one tool it would be a page whose only content is a
    # link to the page you actually wanted. When a second tool arrives this is
    # the line to replace.
    #
    # 302, not Starlette's default 307: this is "the shell lives over there",
    # not a method-preserving replay of the request.
    return RedirectResponse(url(request, TOOLS[0].path), status_code=302)


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.exception_handler(404)
async def not_found(request: Request, exc):
    return render(request, "404.html", status_code=404)
