"""Validating a URL that came from a caller.

Pure string logic, no framework imports — deliberately. This is the check that
decides whether a just-authenticated user lands on our page or on someone
else's, so it has to be testable on its own, without a container or a request
object to build first. `test/test_next.py` runs it with nothing but python3.
"""

DEFAULT_NEXT = "/"

# ASCII whitespace a browser trims from the ends of a URL before resolving it.
# A leading one is the point: " //evil.com" is trimmed back to "//evil.com".
_TRIMMED = " \t\n\r\x0b\x0c"


def _is_control(c: str) -> bool:
    return ord(c) < 0x20 or ord(c) == 0x7F


def safe_next(nxt: str) -> str:
    """Where to send the caller afterwards, or DEFAULT_NEXT if that is not
    somewhere on this origin.

    A leading "/" does not prove a path is local. A fake login page is
    convincing precisely because the victim arrived at it from our domain, and
    there are several ways past a naive test:

      - "//evil.com" is protocol-relative: the browser reads it as a host.
      - "/\\evil.com" — backslashes are normalised to slashes first.
      - "/\\t/evil.com" — tabs, newlines and NULs are *deleted* first, so a
        rejected "//" can be smuggled through with one in the middle. This is
        what a `startswith(("//", "/\\\\"))` guard still lets through.
      - " //evil.com" — leading whitespace is trimmed, exposing the "//".

    Two rules, in this order, and the order is the point:

    1. **Refuse anything holding a control character**, rather than stripping it
       out and carrying on. Sanitising here would hand back "/legitSet-Cookie:…"
       for a CRLF-injection attempt — technically local, but it means quietly
       repairing hostile input and continuing as though it were a typo. Nothing
       this app generates contains one, so its presence is the answer.
    2. **Normalise the way a browser does, then test.** Trim the ends, fold
       backslashes to slashes, and only then ask whether it is a local path.
       Testing before normalising is what every bypass above has in common.
    """
    if not isinstance(nxt, str) or not nxt:
        return DEFAULT_NEXT

    if any(_is_control(c) for c in nxt):
        return DEFAULT_NEXT

    normalised = nxt.strip(_TRIMMED).replace("\\", "/")

    if not normalised.startswith("/") or normalised.startswith("//"):
        return DEFAULT_NEXT

    # The normalised form, not the original: it is what a browser would resolve,
    # so it is what the rest of the app should be reasoning about.
    return normalised
