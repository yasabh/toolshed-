"""ShrinkPDF — compress PDFs in the browser.

There is no compression code here, and that is the design. Ghostscript is
compiled to WebAssembly and runs in a Web Worker on the user's own machine
(`static/gs-worker.js`); this module serves the page and nothing else. The route
is GET-only, so there is no upload endpoint to find.

What that bought, all of which used to live in this file:

  - The claim on the page — that nothing is uploaded — is true, rather than a
    promise about how carefully the server deletes things.
  - Ghostscript is no longer a large C parser reading hostile input on the box
    that also runs gatekeeper, Grafana and tv-webui. It is gone from the image.
  - The Pi does no work at all. It was a 3.7 GB machine running one compression
    at a time behind a semaphore; now it serves 15.4 MB of static wasm, cached.
  - No temp files, no upload cap, no per-process rlimits, no queue, no zip.

The cost is honest and worth stating: the tool needs JavaScript, a browser new
enough for module workers, and a one-time 15.4 MB download.

The two limits below are advisory — the browser is enforcing them on itself, and
a user editing them only affects their own machine. They are here so the page and
its script have one place to read them from.
"""

from fastapi import APIRouter, Request

from app.registry import Tool
from app.render import render

router = APIRouter()

# Not a security boundary any more: past roughly this size a browser tab is
# liable to run out of memory mid-compression, and saying so beforehand beats
# a tab that dies with no explanation.
MAX_BYTES = 100 * 1024 * 1024
MAX_FILES = 20


@router.get("")
async def form(request: Request):
    return render(
        request,
        "pdf.html",
        tool=TOOL,
        max_bytes=MAX_BYTES,
        max_mb=MAX_BYTES // 1024 // 1024,
        max_files=MAX_FILES,
    )


TOOL = Tool(
    id="pdf",
    path="/pdf",
    name="ShrinkPDF",
    nav="ShrinkPDF · PDF compress",
    icon=(
        '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>'
        '<path d="M14 3v5h5"/><path d="M12 12v6M9.5 15.5 12 18l2.5-2.5"/>'
    ),
    router=router,
)
