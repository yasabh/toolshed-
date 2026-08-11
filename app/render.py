"""One way to render a page, so no template can forget the prefix helper."""

from pathlib import Path

from starlette.requests import Request
from starlette.responses import HTMLResponse
from starlette.templating import Jinja2Templates

from app import csrf, gate, prefix
from app.registry import Tool

TEMPLATES = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


def render(
    request: Request,
    template: str,
    tool: Tool | None = None,
    status_code: int = 200,
    **context,
) -> HTMLResponse:
    from app.tools import TOOLS  # late: tools import this module

    response = TEMPLATES.TemplateResponse(
        request,
        template,
        {
            # Bound to this request, because the prefix is a per-request header.
            "url": lambda path: prefix.url(request, path),
            "tools": TOOLS,
            "tool": tool,
            "user": gate.current_user(request),
            # Every rendered page can carry a form, so every rendered page mints
            # the token. A tool that forgets the hidden field fails its own POST
            # rather than quietly accepting a forged one.
            "csrf_token": csrf.token_for(request),
            **context,
        },
        status_code=status_code,
    )
    csrf.attach(request, response)
    return response
