// Serving public/ — the shell's CSS and JS, and the 15.4 MB vendored wasm.
//
// Caching is the interesting part, and getting it wrong is expensive: `no-store`
// on the vendored Ghostscript would mean re-downloading 15.4 MB on every single
// page load. So static assets are cached and pages are not, and the two are
// decided here rather than by a blanket header.
import { createReadStream, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, extname, resolve, sep } from "node:path";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "public"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  // Without this exact type the browser cannot stream-compile the wasm and
  // silently falls back to buffering all 15.4 MB before compiling any of it.
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

// Files that carry their meaning in the name instead of an extension. Without
// this a licence falls to application/octet-stream, which a browser reads as
// "save me" — so the one link whose whole job is to *show* the licence downloads
// it instead.
//
// Matched as a prefix, not as an exact name. The first version of this listed
// "license" exactly, which fixed LICENSE and then missed LICENSE-pdfjs the
// moment a second vendored package arrived — the same bug twice, because the
// rule was written for the file in front of it rather than for the family it
// belongs to. LICENSE.txt and COPYING.LESSER would have missed too.
const NAMED = /^(license|copying|notice)\b/i;

const contentType = (file) =>
  TYPES[extname(file)] ||
  (NAMED.test(basename(file)) ? "text/plain; charset=utf-8" : null) ||
  "application/octet-stream";

/**
 * Resolve a `/static/...` URL to a file inside public/, or null.
 *
 * The resolved path is checked to still be under ROOT rather than the URL being
 * inspected for "..": the check then holds whatever the encoding, and it is the
 * filesystem's own answer rather than our reading of the string.
 */
export function resolveStatic(routePath) {
  if (!routePath.startsWith("/static/")) return null;
  const rest = decodeURIComponent(routePath.slice("/static/".length));
  const full = resolve(join(ROOT, rest));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

function cacheControl(routePath) {
  // The vendored build only changes when test/vendor.sh is re-run, so it is
  // cached hard. Our own CSS and JS revalidate instead — they are a few kB, so
  // an ETag round-trip is free and an edit shows up at once.
  return routePath.startsWith("/static/vendor/")
    ? "public, max-age=604800"
    : "no-cache";
}

export async function serveStatic(req, res, routePath, headers) {
  const file = resolveStatic(routePath);
  if (!file) return false;

  let stat;
  try {
    stat = await fs.stat(file);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  // Size and mtime, which is what changes when vendor.sh writes a new build.
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const base = {
    ...headers,
    "content-type": contentType(file),
    "cache-control": cacheControl(routePath),
    etag,
    "last-modified": stat.mtime.toUTCString(),
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, base);
    res.end();
    return true;
  }

  // Range matters here for one asset in particular: the vendored Ghostscript is
  // 15.4 MB, and without this an interrupted download restarts from zero instead
  // of resuming. A single range is enough — nothing asks this server for more.
  base["accept-ranges"] = "bytes";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    const [, rawStart, rawEnd] = range;
    // "bytes=-500" means the last 500, not "from 0 to 500".
    const start = rawStart === "" ? Math.max(0, stat.size - Number(rawEnd)) : Number(rawStart);
    const end = rawStart === "" || rawEnd === "" ? stat.size - 1 : Number(rawEnd);

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { ...base, "content-range": `bytes */${stat.size}` });
      return void res.end(), true;
    }
    const last = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      ...base,
      "content-range": `bytes ${start}-${last}/${stat.size}`,
      "content-length": String(last - start + 1),
    });
    if (req.method === "HEAD") return void res.end(), true;
    createReadStream(file, { start, end: last }).pipe(res);
    return true;
  }

  res.writeHead(200, { ...base, "content-length": String(stat.size) });
  if (req.method === "HEAD") return void res.end(), true;
  createReadStream(file).pipe(res);
  return true;
}
