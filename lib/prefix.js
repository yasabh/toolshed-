// Where this app thinks it lives.
//
// gatekeeper strips `/toolshed` before proxying
// (`rewrite ^/toolshed/(.*)$ /$1 break;`), so the path this app routes on is
// already unprefixed — and every URL it *emits* must have the prefix put back,
// or the browser aims at the gateway's root and lands on tv-webui's catch-all
// `location /`.
//
// One rule, one place: routing matches the plain stripped path, and every
// emitted URL goes through url().

/** `/toolshed` behind the gateway, `` when reached directly. */
export function prefixOf(req) {
  // A prefix of "/" is the same as none, and a trailing slash would double up
  // against the leading slash of every path.
  return (req.headers["x-forwarded-prefix"] || "").replace(/\/+$/, "");
}

/**
 * Turn an app-internal path into one the browser can follow.
 *
 * `path` is always written as this app sees it (`/pdf`, `/static/style.css`) —
 * the prefix is the gateway's business, never hardcoded at a call site.
 */
export function url(req, path) {
  if (!path.startsWith("/")) throw new Error(`url() takes an app-absolute path, got ${path}`);
  return prefixOf(req) + path;
}

/**
 * The path to route on: query stripped, and a trailing slash normalised away.
 *
 * Normalised here rather than answered with a redirect, because a redirect built
 * from the *stripped* path would send the browser to `/pdf` at the gateway root
 * — straight into tv-webui's catch-all. Rewriting means there is no redirect to
 * get wrong.
 */
export function routePath(reqUrl) {
  const path = reqUrl.split("?")[0].split("#")[0];
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}
