// The sign-in gate — deliberately not implemented yet.
//
// Everything in this app is meant to sit behind sign-in; there is no public path
// like tv-webui's `/media/live`. That makes the gate one check in one place,
// which is why this file exists now, empty, rather than being retrofitted later
// into each route.
//
// What it will do, when it is wired up (contract as in tvremotehub's
// lib/auth.js — http://auth:8080 on the edge network, plain HTTP, no host port):
//
//   - Ask auth who the caller is, per request. Never cache the answer: web
//     sessions expire at the coming Saturday 00:00 Europe/Budapest and WiFi
//     identity is re-derived per request, both of which are auth's business.
//   - Fail CLOSED on a 5xx or a timeout. We cannot tell a visitor from an
//     employee, so we serve neither.
//   - Refuse in the shape the caller expects. isNavigation() below is that
//     decision:
//       * browser navigation -> 302 to loginUrl(), which carries the gateway
//         prefix in `next` — otherwise it aims at the gateway's root.
//       * background XHR / WebSocket -> a bare 401. This is the whole reason the
//         gate moved out of nginx: `auth_request` redirected both and handed
//         fetch() a login page as a cheerful 200.
//
// What it must *not* do: decide anything from X-Auth-User. That header is
// trustworthy only because nginx overwrites it on every proxied hop, a guarantee
// that evaporates the moment anything can reach this app's port directly — which
// is why publishing a port is a security bug and not untidiness.
import { safeNext } from "./links.js";
import { url } from "./prefix.js";

/**
 * True when a refusal should be a redirect rather than a bare 401.
 *
 * `Sec-Fetch-Mode: navigate` is exactly the question being asked — the browser
 * tells us whether this is a top-level navigation or a background fetch. Older
 * browsers send no Sec-Fetch-* at all; those fall back to Accept, where a
 * navigation asks for HTML and fetch() here is told to ask for JSON.
 */
export function isNavigation(req) {
  const mode = req.headers["sec-fetch-mode"];
  if (mode) return mode === "navigate";
  return (req.headers.accept || "").includes("text/html");
}

/** Display only. The authorisation decision is the auth call, not this. */
export const currentUser = (req) => req.headers["x-auth-user"] || "";

/**
 * `/login?next=…`, with the next pointing back *here*.
 *
 * /login is the gateway's own route, so it is not built through url() — but the
 * destination is one of ours and must carry the prefix, or it aims at the
 * gateway's root.
 */
export function loginUrl(req, path, query) {
  let target = url(req, safeNext(path));
  if (query) target += `?${query}`;
  return `/login?next=${encodeURIComponent(target)}`;
}

/**
 * Placeholder. Lets every request through, on purpose.
 *
 * Wiring the real check happens here and nowhere else: ask auth, and on a
 * refusal short-circuit with the shape isNavigation() picks. Returning false
 * means "already answered the client".
 */
export async function guard(_req, _res) {
  return true;
}
