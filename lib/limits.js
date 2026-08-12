// Refusing an oversized body before anything reads it.
//
// The enforcing check is Content-Length, refused before the body is touched.
// That is only as good as the header, which is why a body with **no**
// Content-Length is refused too:
//
//   - nginx buffers a proxied request body and sets an accurate Content-Length,
//     so behind gatekeeper the header is a fact rather than a claim, and a
//     chunked upload never reaches us in that shape.
//   - Which leaves lying about it, or omitting it — both of which require
//     talking to :8080 directly, which is precisely what "no published ports"
//     prevents. The same reasoning is what makes X-Auth-User trustworthy, and it
//     fails in the same way if anything ever publishes that port.
//
// Nothing uploads anything today — ShrinkPDF compresses in the browser — but
// this is the shell's rule rather than a tool's, so the next tool inherits it
// instead of having to remember it.

export const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 100 * 1024 * 1024);

// GET and HEAD carry no body worth measuring.
const BODILESS = new Set(["GET", "HEAD"]);

/**
 * null when the request may proceed, otherwise {status, message} to answer with.
 */
export function checkBody(req, max = MAX_BODY_BYTES) {
  if (BODILESS.has(req.method)) return null;

  const declared = req.headers["content-length"];
  if (declared === undefined) {
    return { status: 411, message: "That request did not say how large it was." };
  }

  const size = Number(declared);
  if (!Number.isFinite(size) || size < 0) {
    return { status: 400, message: "Malformed Content-Length." };
  }
  if (size > max) {
    return { status: 413, message: `That is larger than the ${Math.floor(max / 1024 / 1024)} MB limit.` };
  }
  return null;
}
