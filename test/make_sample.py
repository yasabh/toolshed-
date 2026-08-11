"""Write a sample PDF that Ghostscript can actually make smaller.

A PDF of plain text is already tiny and /screen leaves it alone, which proves
nothing. This is one oversized image on one page — the case people bring to a
PDF compressor, and the case the presets act on.
"""

import sys
import zlib

W, H = 1224, 1584  # ~144 dpi on a letter page, so /screen has something to drop


def image_data() -> bytes:
    # A gradient with a repeating ripple: compresses like a photograph rather
    # than like a blank rectangle, so the before/after numbers mean something.
    rows = bytearray()
    for y in range(H):
        for x in range(W):
            rows += bytes(((x * 7 + y * 3) % 256, (x * 13) % 256, (y * 11 + x) % 256))
    return zlib.compress(bytes(rows), 6)


def build() -> bytes:
    img = image_data()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length 44 >>\nstream\nq 612 0 0 792 0 0 cm /Im0 Do Q\nendstream",
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB "
        b"/BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n"
        % (W, H, len(img))
        + img
        + b"\nendstream",
    ]

    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"

    xref = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return bytes(out)


if __name__ == "__main__":
    data = build()
    with open(sys.argv[1], "wb") as fh:
        fh.write(data)
    print(f"{sys.argv[1]}: {len(data)} bytes")
