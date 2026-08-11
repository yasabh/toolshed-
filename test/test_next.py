"""Where a caller is sent after sign-in. `next` is attacker-controlled.

Plain asserts, no pytest — this has to be runnable anywhere, including inside
the image where the only thing installed is what the app needs.

    python3 test/test_next.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.links import DEFAULT_NEXT, safe_next  # noqa: E402

HOSTILE = [
    "//evil.com",            # protocol-relative: the browser reads a host
    "///evil.com",
    "/\\evil.com",           # backslashes are normalised to slashes first
    "/\\/evil.com",
    "/\t/evil.com",          # tabs are deleted first, leaving "//evil.com"
    "/\n/evil.com",          # …and so are newlines
    "/\r/evil.com",
    " //evil.com",           # leading whitespace is trimmed, exposing the "//"
    "\t//evil.com",
    "/\x00/evil.com",
    "https://evil.com",
    "evil.com",
    "",
    "javascript:alert(1)",
    "/legit\r\nSet-Cookie: x=1",   # header injection through a redirect
]

LOCAL = [
    "/tools/pdf",
    "/toolshed/pdf",
    "/tools/pdf?quality=screen",
    "/tools/static/app.js",
    # A space mid-path is not an escape: the browser percent-encodes it rather
    # than deleting it, so this stays a local path and the guard must not cost
    # someone the page they were heading to.
    "/tools/a b",
]

failures = 0
for nxt in HOSTILE:
    got = safe_next(nxt)
    if got != DEFAULT_NEXT:
        print(f"  FAIL {nxt!r} -> {got!r}, expected {DEFAULT_NEXT!r}")
        failures += 1
    else:
        print(f"  ok   {nxt!r} refused")

for nxt in LOCAL:
    got = safe_next(nxt)
    if got != nxt:
        print(f"  FAIL {nxt!r} -> {got!r}, should have been kept")
        failures += 1
    else:
        print(f"  ok   {nxt!r} kept")

print(f"\n{len(HOSTILE) + len(LOCAL) - failures} passed, {failures} failed")
sys.exit(1 if failures else 0)
