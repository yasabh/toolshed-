// Finding the images in a PDF, by reading the file rather than asking
// Ghostscript.
//
// Ghostscript reports nothing about its own image handling. `-dPDFDEBUG` makes
// it dump every object it reads, which does contain the image dictionaries — but
// it costs a callback into JS per line for the whole file, and on a
// thousand-image brochure that is far more expensive than the compression.
//
// This reads the bytes instead, and it works because of one rule in the PDF
// spec: **an object with a stream may not live inside an object stream.** Every
// image XObject has a stream, so every image dictionary is a top-level object,
// written in plain text even when the rest of the file is compressed. That holds
// for PDF 1.5+ output from pdfwrite, which is what made re-reading its output
// look impossible at first.
//
// The same scanner runs over the input and the output, which matters more than
// either being exhaustive: an exotic image missed on one side is missed on the
// other, so the comparison stays honest.

// A dictionary key may appear before or after /Subtype, so the window reaches
// both ways rather than assuming a producer's key order.
const SUBTYPE_IMAGE = /\/Subtype\s*\/Image\b/g;
const WINDOW = 400;

function readDims(text, at) {
  const from = Math.max(0, at - WINDOW);
  const slice = text.slice(from, at + WINDOW);
  const w = /\/Width\s+(\d+)/.exec(slice);
  const h = /\/Height\s+(\d+)/.exec(slice);
  return w && h ? { w: +w[1], h: +h[1] } : null;
}

/** Every image XObject in a PDF, as {w, h}. */
export function findImages(bytes) {
  // latin1 maps every byte to one code unit, so offsets in the string are byte
  // offsets — no multi-byte decoding to throw the windows off.
  const text = new TextDecoder("latin1").decode(bytes);
  const found = [];
  SUBTYPE_IMAGE.lastIndex = 0;
  let match;
  while ((match = SUBTYPE_IMAGE.exec(text)) !== null) {
    const dims = readDims(text, match.index);
    if (dims) found.push(dims);
  }
  return found;
}

/**
 * What happened to the images, by comparing before with after.
 *
 * An image whose exact pixel dimensions still exist in the source was not
 * resampled; anything else was. Counted as a multiset rather than paired by
 * position, because pdfwrite is free to reorder objects and a reordering must
 * not read as a resize.
 */
export function compareImages(before, after) {
  const key = (i) => `${i.w}x${i.h}`;
  const pool = new Map();
  for (const image of before) {
    pool.set(key(image), (pool.get(key(image)) || 0) + 1);
  }

  let kept = 0;
  for (const image of after) {
    const remaining = pool.get(key(image)) || 0;
    if (remaining > 0) {
      pool.set(key(image), remaining - 1);
      kept++;
    }
  }

  return { total: after.length, resized: after.length - kept, kept };
}
