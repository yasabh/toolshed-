"""The registry the shell renders itself from.

Adding a tool is: write `tools/<id>.py` exposing `TOOL`, then list it here. The
sidebar, the routes and the `<h1>` all come from this one list, so a tool cannot
be reachable but unlisted, or listed under a name its page does not use.
"""

from app.registry import Tool
from app.tools import pdf

TOOLS: list[Tool] = [pdf.TOOL]

BY_ID = {t.id: t for t in TOOLS}
